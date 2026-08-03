import UIKit
import UniformTypeIdentifiers
@preconcurrency import Vision

final class ShareViewController: UIViewController, UITextFieldDelegate {
    private let scrollView = UIScrollView()
    private let stack = UIStackView()
    private let merchantField = PaisaTextField(title: "Merchant")
    private let amountField = PaisaTextField(title: "Amount", placeholder: "₹0")
    private let categoryField = PaisaTextField(title: "Category")
    private let noteField = PaisaTextField(title: "Note", placeholder: "Optional")
    private let progress = UIActivityIndicatorView(style: .medium)
    private let progressLabel = UILabel()
    private let saveButton = UIButton(type: .system)
    private var extractedText = ""

    override func viewDidLoad() {
        super.viewDidLoad()
        configureUI()
        Task { await loadSharedContent() }
    }

    private func configureUI() {
        view.backgroundColor = UIColor(red: 246 / 255, green: 243 / 255, blue: 236 / 255, alpha: 1)
        navigationItem.title = "Save to Paisa Inbox"

        let header = UILabel()
        header.text = "Add payment"
        header.font = .systemFont(ofSize: 29, weight: .bold)
        header.textColor = .paisaInk

        let subtitle = UILabel()
        subtitle.text = "Check what Paisa Inbox found, then save it to your daily inbox."
        subtitle.font = .systemFont(ofSize: 15)
        subtitle.textColor = .paisaMuted
        subtitle.numberOfLines = 0

        let cancelButton = UIButton(type: .system)
        cancelButton.setTitle("Cancel", for: .normal)
        cancelButton.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        cancelButton.tintColor = .paisaForest
        cancelButton.addTarget(self, action: #selector(cancel), for: .touchUpInside)

        let topRow = UIStackView(arrangedSubviews: [header, UIView(), cancelButton])
        topRow.alignment = .center

        progress.startAnimating()
        progress.color = .paisaForest
        progressLabel.text = "Reading payment details…"
        progressLabel.font = .systemFont(ofSize: 14, weight: .medium)
        progressLabel.textColor = .paisaMuted
        let progressRow = UIStackView(arrangedSubviews: [progress, progressLabel, UIView()])
        progressRow.axis = .horizontal
        progressRow.alignment = .center
        progressRow.spacing = 10

        merchantField.field.autocapitalizationType = .words
        merchantField.field.textContentType = .organizationName
        amountField.field.keyboardType = .decimalPad
        amountField.field.delegate = self
        categoryField.field.text = "Uncategorised"
        categoryField.field.autocapitalizationType = .words
        noteField.field.autocapitalizationType = .sentences

        saveButton.setTitle("Save payment", for: .normal)
        saveButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .bold)
        saveButton.backgroundColor = .paisaForest
        saveButton.tintColor = .white
        saveButton.layer.cornerRadius = 15
        saveButton.heightAnchor.constraint(equalToConstant: 54).isActive = true
        saveButton.addTarget(self, action: #selector(save), for: .touchUpInside)

        stack.axis = .vertical
        stack.spacing = 18
        [topRow, subtitle, progressRow, merchantField, amountField, categoryField, noteField, saveButton].forEach(stack.addArrangedSubview)

        view.addSubview(scrollView)
        scrollView.addSubview(stack)
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 24),
            stack.leadingAnchor.constraint(equalTo: scrollView.frameLayoutGuide.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: scrollView.frameLayoutGuide.trailingAnchor, constant: -20),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -24)
        ])

        let tap = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))
        tap.cancelsTouchesInView = false
        view.addGestureRecognizer(tap)
    }

    @MainActor
    private func loadSharedContent() async {
        let inputItems = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        let providers = inputItems.flatMap { $0.attachments ?? [] }
        var textParts = inputItems.flatMap { item in [item.attributedTitle?.string, item.attributedContentText?.string].compactMap { $0 } }

        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier),
               let image = await loadImage(from: provider),
               let text = await recognizeText(in: image), !text.isEmpty {
                textParts.append(text)
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                      let text = await loadString(from: provider, type: .plainText) {
                textParts.append(text)
            } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                      let text = await loadString(from: provider, type: .url) {
                textParts.append(text)
            } else if provider.hasItemConformingToTypeIdentifier(UTType.html.identifier),
                      let text = await loadString(from: provider, type: .html) {
                textParts.append(text.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression))
            }
        }

        extractedText = textParts.joined(separator: "\n")
        let details = ReceiptParser.parse(extractedText)
        merchantField.field.text = details.merchant
        if let amount = details.amount {
            amountField.field.text = ReceiptParser.displayAmount(amount)
        }
        if let note = details.note { noteField.field.text = note }
        progress.stopAnimating()
        progress.isHidden = true
        progressLabel.text = extractedText.isEmpty
            ? "Enter the payment details below."
            : "Details extracted — check before saving."
        merchantField.field.becomeFirstResponderIfEmpty()
    }

    private func loadImage(from provider: NSItemProvider) async -> CGImage? {
        guard let item = try? await provider.loadItem(forTypeIdentifier: UTType.image.identifier) else { return nil }
        if let image = item as? UIImage { return image.cgImage }
        if let url = item as? URL, let image = UIImage(contentsOfFile: url.path) { return image.cgImage }
        if let data = item as? Data, let image = UIImage(data: data) { return image.cgImage }
        return nil
    }

    private func loadString(from provider: NSItemProvider, type: UTType) async -> String? {
        guard let item = try? await provider.loadItem(forTypeIdentifier: type.identifier) else { return nil }
        if let string = item as? String { return string }
        if let url = item as? URL { return url.absoluteString }
        if let data = item as? Data { return String(data: data, encoding: .utf8) }
        return nil
    }

    private func recognizeText(in image: CGImage) async -> String? {
        await withCheckedContinuation { continuation in
            let request = VNRecognizeTextRequest { request, _ in
                let lines = (request.results as? [VNRecognizedTextObservation] ?? [])
                    .compactMap { $0.topCandidates(1).first?.string }
                continuation.resume(returning: lines.joined(separator: "\n"))
            }
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["en-IN", "en-US"]
            request.usesLanguageCorrection = true
            DispatchQueue.global(qos: .userInitiated).async {
                do { try VNImageRequestHandler(cgImage: image).perform([request]) }
                catch { continuation.resume(returning: nil) }
            }
        }
    }

    @objc private func save() {
        dismissKeyboard()
        guard let merchant = merchantField.field.text?.trimmingCharacters(in: .whitespacesAndNewlines), !merchant.isEmpty else {
            merchantField.showError("Add a merchant name")
            return
        }
        merchantField.showError(nil)
        guard let amount = ReceiptParser.amount(from: amountField.field.text ?? ""), amount > 0 else {
            amountField.showError("Add a valid amount")
            return
        }
        amountField.showError(nil)

        let category = categoryField.field.text?.trimmingCharacters(in: .whitespacesAndNewlines)
        let note = noteField.field.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let receipt = SharedReceipt(
            id: UUID(),
            merchant: merchant,
            amount: amount,
            category: category?.isEmpty == false ? category! : "Uncategorised",
            note: note,
            occurredAt: .now,
            createdAt: .now
        )
        do {
            try SharedInbox.save(receipt)
            saveButton.isEnabled = false
            saveButton.setTitle("Opening Paisa Inbox…", for: .normal)
            let inboxURL = URL(string: "paisa://inbox")!
            extensionContext?.open(inboxURL) { [weak self] _ in self?.extensionContext?.completeRequest(returningItems: nil) }
        } catch {
            let alert = UIAlertController(title: "Couldn’t save payment", message: error.localizedDescription, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default))
            present(alert, animated: true)
        }
    }

    @objc private func cancel() {
        extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }

    @objc private func dismissKeyboard() { view.endEditing(true) }

    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
        let allowed = CharacterSet(charactersIn: "0123456789.,₹ ")
        return string.unicodeScalars.allSatisfy { allowed.contains($0) }
    }
}

private final class PaisaTextField: UIView {
    let field = UITextField()
    private let errorLabel = UILabel()

    init(title: String, placeholder: String? = nil) {
        super.init(frame: .zero)
        let label = UILabel()
        label.text = title.uppercased()
        label.font = .systemFont(ofSize: 11, weight: .bold)
        label.textColor = .paisaMuted

        field.placeholder = placeholder
        field.font = .systemFont(ofSize: 17, weight: .medium)
        field.textColor = .paisaInk
        field.backgroundColor = UIColor(red: 252 / 255, green: 250 / 255, blue: 245 / 255, alpha: 1)
        field.layer.cornerRadius = 14
        field.layer.borderWidth = 1
        field.layer.borderColor = UIColor(red: 219 / 255, green: 216 / 255, blue: 207 / 255, alpha: 1).cgColor
        field.setLeftPadding(14)
        field.setRightPadding(14)
        field.heightAnchor.constraint(equalToConstant: 52).isActive = true

        errorLabel.font = .systemFont(ofSize: 12, weight: .medium)
        errorLabel.textColor = .systemRed
        errorLabel.numberOfLines = 0
        errorLabel.isHidden = true

        let stack = UIStackView(arrangedSubviews: [label, field, errorLabel])
        stack.axis = .vertical
        stack.spacing = 7
        addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func showError(_ message: String?) {
        errorLabel.text = message
        errorLabel.isHidden = message == nil
        field.layer.borderColor = (message == nil ? UIColor.paisaLine : UIColor.systemRed).cgColor
    }
}

private enum ReceiptParser {
    struct Details { let merchant: String; let amount: Double?; let note: String? }

    static func parse(_ text: String) -> Details {
        let lines = text.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let amount = bestAmount(in: lines)
        let merchant = bestMerchant(in: lines)
        let note = lines.first(where: { line in
            let lower = line.lowercased()
            return lower.contains("upi") || lower.contains("transaction id") || lower.contains("reference")
        }).map { String($0.prefix(160)) }
        return Details(merchant: merchant, amount: amount, note: note)
    }

    static func amount(from text: String) -> Double? {
        let cleaned = text.replacingOccurrences(of: "₹", with: "")
            .replacingOccurrences(of: "INR", with: "", options: .caseInsensitive)
            .replacingOccurrences(of: "Rs.", with: "", options: .caseInsensitive)
            .replacingOccurrences(of: "Rs", with: "", options: .caseInsensitive)
            .replacingOccurrences(of: ",", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return Double(cleaned)
    }

    static func displayAmount(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_IN")
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = value.rounded() == value ? 0 : 2
        formatter.maximumFractionDigits = 2
        return formatter.string(from: NSNumber(value: value)) ?? String(value)
    }

    private static func bestAmount(in lines: [String]) -> Double? {
        let pattern = #"(?i)(?:₹|INR|Rs\.?)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        var candidates: [(value: Double, score: Int)] = []
        for (index, line) in lines.enumerated() {
            let range = NSRange(line.startIndex..., in: line)
            for match in regex.matches(in: line, range: range) {
                guard let valueRange = Range(match.range(at: 1), in: line),
                      let value = amount(from: String(line[valueRange])) else { continue }
                let lower = line.lowercased()
                var score = 1
                if lower.contains("paid") || lower.contains("sent") || lower.contains("debited") { score += 8 }
                if lower.contains("amount") || lower.contains("total") { score += 5 }
                if lower.contains("balance") || lower.contains("cashback") || lower.contains("reward") { score -= 7 }
                score += max(0, 3 - index)
                candidates.append((value, score))
            }
        }
        return candidates.max { lhs, rhs in lhs.score == rhs.score ? lhs.value < rhs.value : lhs.score < rhs.score }?.value
    }

    private static func bestMerchant(in lines: [String]) -> String {
        if let urlLine = lines.first(where: { $0.hasPrefix("http://") || $0.hasPrefix("https://") }),
           let host = URL(string: urlLine)?.host {
            return host.replacingOccurrences(of: "www.", with: "")
        }
        let prefixes = ["paid to", "sent to", "payment to", "transferred to", "merchant"]
        for line in lines {
            let lower = line.lowercased()
            for prefix in prefixes where lower.contains(prefix) {
                let start = lower.range(of: prefix)!.upperBound
                let candidate = cleanMerchant(String(line[start...]))
                if !candidate.isEmpty { return candidate }
            }
        }
        let noise = ["payment", "successful", "completed", "paytm", "google pay", "gpay", "transaction", "upi", "bank", "date", "time", "share", "done"]
        for line in lines {
            let lower = line.lowercased()
            guard !line.contains("₹"), amount(from: line) == nil,
                  line.count >= 3, line.count <= 60,
                  !noise.contains(where: { lower == $0 || lower.hasPrefix("\($0) ") }) else { continue }
            return cleanMerchant(line)
        }
        return ""
    }

    private static func cleanMerchant(_ value: String) -> String {
        value
            .replacingOccurrences(of: #"(?i)\s+(?:via|using)\s+.*$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s+[\w.%-]+@[\w.-]+.*$"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: " :-–—|"))
    }
}

private extension UITextField {
    func setLeftPadding(_ value: CGFloat) {
        let padding = UIView(frame: CGRect(x: 0, y: 0, width: value, height: 1))
        leftView = padding
        leftViewMode = .always
    }

    func setRightPadding(_ value: CGFloat) {
        let padding = UIView(frame: CGRect(x: 0, y: 0, width: value, height: 1))
        rightView = padding
        rightViewMode = .always
    }

    func becomeFirstResponderIfEmpty() {
        if text?.isEmpty != false { becomeFirstResponder() }
    }
}

private extension UIColor {
    static let paisaForest = UIColor(red: 23 / 255, green: 61 / 255, blue: 53 / 255, alpha: 1)
    static let paisaInk = UIColor(red: 24 / 255, green: 35 / 255, blue: 31 / 255, alpha: 1)
    static let paisaMuted = UIColor(red: 103 / 255, green: 110 / 255, blue: 103 / 255, alpha: 1)
    static let paisaLine = UIColor(red: 219 / 255, green: 216 / 255, blue: 207 / 255, alpha: 1)
}
