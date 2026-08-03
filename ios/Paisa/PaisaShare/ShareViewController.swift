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
    private let occurredAtPicker = UIDatePicker()
    private let timestampHint = UILabel()
    private let accountButton = UIButton(type: .system)
    private let progress = UIActivityIndicatorView(style: .medium)
    private let progressLabel = UILabel()
    private let saveButton = UIButton(type: .system)
    private var extractedText = ""
    private var selectedAccountName: String?
    private var timeVerified = false

    override func viewDidLoad() {
        super.viewDidLoad()
        let appearance = SharedAppearance.current()
        overrideUserInterfaceStyle = appearance == "dark" ? .dark : appearance == "light" ? .light : .unspecified
        configureUI()
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (controller: ShareViewController, _) in controller.applyAppearance() }
        Task { await loadSharedContent() }
    }

    private func configureUI() {
        view.backgroundColor = .paisaCanvas
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
        occurredAtPicker.datePickerMode = .dateAndTime
        occurredAtPicker.preferredDatePickerStyle = .compact
        occurredAtPicker.locale = Locale(identifier: "en_IN")
        occurredAtPicker.addTarget(self, action: #selector(timestampChanged), for: .valueChanged)
        timestampHint.text = "Using current time until a timestamp is found."
        timestampHint.font = .systemFont(ofSize: 12)
        timestampHint.textColor = .paisaMuted
        timestampHint.numberOfLines = 0
        configureAccountButton()
        applyAppearance()

        saveButton.setTitle("Save payment", for: .normal)
        saveButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .bold)
        saveButton.backgroundColor = .paisaForest
        saveButton.tintColor = .paisaPrimaryForeground
        saveButton.layer.cornerRadius = 15
        saveButton.heightAnchor.constraint(equalToConstant: 54).isActive = true
        saveButton.addTarget(self, action: #selector(save), for: .touchUpInside)

        stack.axis = .vertical
        stack.spacing = 18
        [topRow, subtitle, progressRow, merchantField, amountField, datePickerView(), accountPickerView(), categoryField, noteField, saveButton].forEach(stack.addArrangedSubview)

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
        var processedImage = false

        for provider in providers {
            if !processedImage, provider.hasItemConformingToTypeIdentifier(UTType.image.identifier),
               let image = await loadImage(from: provider) {
                processedImage = true
                let fastText = await recognizeText(in: image, accurate: false) ?? ""
                let fastDetails = ReceiptParser.parse(fastText)
                let needsAccurateRetry = fastDetails.amount == nil || fastDetails.merchant.isEmpty || fastDetails.occurredAt == nil || !fastDetails.timeVerified
                let text = needsAccurateRetry ? (await recognizeText(in: image, accurate: true) ?? fastText) : fastText
                if !text.isEmpty { textParts.append(text) }
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
        if let occurredAt = details.occurredAt {
            occurredAtPicker.date = occurredAt
            timeVerified = details.timeVerified
            timestampHint.text = details.timeVerified ? "Date and exact time extracted from the screenshot." : "Date extracted; time was not visible."
        }
        categoryField.field.text = details.category
        if let note = details.note { noteField.field.text = note }
        progress.stopAnimating()
        progress.isHidden = true
        progressLabel.text = extractedText.isEmpty
            ? "Enter the payment details below."
            : "Details extracted — check before saving."
        merchantField.field.becomeFirstResponderIfEmpty()
    }

    private func configureAccountButton() {
        let accounts = SharedPaymentAccountDirectory.all()
        let profile = SharedCaptureProfileDirectory.current()
        let preferred = accounts.first { $0.name.localizedCaseInsensitiveContains("paytm") }
            ?? accounts.first { $0.name == profile.lastAccountName }
            ?? (accounts.count == 1 ? accounts[0] : nil)
        selectedAccountName = preferred?.name
        accountButton.setTitle(preferred?.displayName ?? "Choose payment account", for: .normal)
        accountButton.contentHorizontalAlignment = .leading
        accountButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .medium)
        accountButton.tintColor = .paisaInk
        accountButton.backgroundColor = .paisaSurface
        accountButton.layer.cornerRadius = 14
        accountButton.layer.borderWidth = 1
        accountButton.layer.borderColor = UIColor.paisaLine.resolvedColor(with: traitCollection).cgColor
        var configuration = UIButton.Configuration.plain()
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 14, bottom: 0, trailing: 14)
        accountButton.configuration = configuration
        accountButton.heightAnchor.constraint(equalToConstant: 52).isActive = true
        accountButton.showsMenuAsPrimaryAction = true
        accountButton.menu = UIMenu(children: accounts.map { account in UIAction(title: account.displayName, state: account.name == selectedAccountName ? .on : .off) { [weak self] _ in self?.selectedAccountName = account.name; self?.accountButton.setTitle(account.displayName, for: .normal); self?.configureAccountButtonMenu() } })
    }

    private func configureAccountButtonMenu() {
        let accounts = SharedPaymentAccountDirectory.all()
        accountButton.menu = UIMenu(children: accounts.map { account in UIAction(title: account.displayName, state: account.name == selectedAccountName ? .on : .off) { [weak self] _ in self?.selectedAccountName = account.name; self?.accountButton.setTitle(account.displayName, for: .normal); self?.configureAccountButtonMenu() } })
    }

    private func accountPickerView() -> UIView {
        let label = UILabel(); label.text = "PAYMENT ACCOUNT"; label.font = .systemFont(ofSize: 11, weight: .bold); label.textColor = .paisaMuted
        let field = UIStackView(arrangedSubviews: [label, accountButton]); field.axis = .vertical; field.spacing = 7
        return field
    }

    private func datePickerView() -> UIView {
        let label = UILabel(); label.text = "PAYMENT DATE & TIME"; label.font = .systemFont(ofSize: 11, weight: .bold); label.textColor = .paisaMuted
        let row = UIStackView(arrangedSubviews: [occurredAtPicker, UIView()]); row.axis = .horizontal
        let field = UIStackView(arrangedSubviews: [label, row, timestampHint]); field.axis = .vertical; field.spacing = 7
        return field
    }

    private func applyAppearance() {
        view.backgroundColor = .paisaCanvas
        navigationController?.navigationBar.barTintColor = .paisaCanvas
        navigationController?.navigationBar.tintColor = .paisaAccent
        accountButton.backgroundColor = .paisaSurface
        accountButton.layer.borderColor = UIColor.paisaLine.resolvedColor(with: traitCollection).cgColor
        [merchantField, amountField, categoryField, noteField].forEach { $0.applyAppearance(for: traitCollection) }
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

    private func recognizeText(in image: CGImage, accurate: Bool) async -> String? {
        let input = downsample(image, maximumDimension: accurate ? 2200 : 1600)
        return await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
            let request = VNRecognizeTextRequest { request, _ in
                let lines = (request.results as? [VNRecognizedTextObservation] ?? [])
                    .compactMap { $0.topCandidates(1).first?.string }
                continuation.resume(returning: lines.joined(separator: "\n"))
            }
            request.recognitionLevel = accurate ? .accurate : .fast
            request.recognitionLanguages = ["en-IN", "en-US"]
            request.usesLanguageCorrection = accurate
            request.minimumTextHeight = accurate ? 0.012 : 0.018
            request.customWords = ["Paytm", "UPI", "Paid Successfully", "Transaction ID", "Paid on", "PM", "AM"]
            DispatchQueue.global(qos: .userInitiated).async {
                do { try VNImageRequestHandler(cgImage: input).perform([request]) }
                catch { continuation.resume(returning: nil) }
            }
        }
    }

    private func downsample(_ image: CGImage, maximumDimension: Int) -> CGImage {
        let longest = max(image.width, image.height)
        guard longest > maximumDimension else { return image }
        let scale = CGFloat(maximumDimension) / CGFloat(longest)
        let width = max(1, Int(CGFloat(image.width) * scale)), height = max(1, Int(CGFloat(image.height) * scale))
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return image }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage() ?? image
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
        let now = Date.now, occurredAt = occurredAtPicker.date
        let receipt = SharedReceipt(
            id: SharedReceipt.captureID(merchant: merchant, amount: amount, occurredAt: occurredAt, reference: note),
            merchant: merchant,
            amount: amount,
            category: category?.isEmpty == false ? category! : "Uncategorised",
            note: note,
            occurredAt: occurredAt,
            timeVerified: timeVerified,
            createdAt: now,
            accountTag: selectedAccountName
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
    @objc private func timestampChanged() { timeVerified = true; timestampHint.text = "Date and exact time confirmed by you." }

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
        field.backgroundColor = .paisaSurface
        field.layer.cornerRadius = 14
        field.layer.borderWidth = 1
        field.layer.borderColor = UIColor.paisaLine.resolvedColor(with: traitCollection).cgColor
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
        field.layer.borderColor = (message == nil ? UIColor.paisaLine.resolvedColor(with: traitCollection) : UIColor.systemRed).cgColor
    }

    func applyAppearance(for traits: UITraitCollection) {
        field.backgroundColor = .paisaSurface
        field.layer.borderColor = UIColor.paisaLine.resolvedColor(with: traits).cgColor
    }
}

private enum ReceiptParser {
    struct Details { let merchant: String; let amount: Double?; let category: String; let note: String?; let occurredAt: Date?; let timeVerified: Bool }

    static func parse(_ text: String) -> Details {
        let lines = text.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let amount = bestAmount(in: lines)
        let merchant = bestMerchant(in: lines)
        let timestamp = bestTimestamp(in: lines)
        let learnedCategory = SharedCaptureProfileDirectory.current().category(for: merchant)
        let category = learnedCategory ?? suggestedCategory(for: merchant)
        let note = lines.first(where: { line in
            let lower = line.lowercased()
            return lower.contains("upi") || lower.contains("transaction id") || lower.contains("reference")
        }).map { String($0.prefix(160)) }
        return Details(merchant: merchant, amount: amount, category: category, note: note, occurredAt: timestamp?.date, timeVerified: timestamp?.timeVerified ?? false)
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
            let context = [index > 0 ? lines[index - 1] : "", line, index + 1 < lines.count ? lines[index + 1] : ""].joined(separator: " ").lowercased()
            if context.range(of: #"\b(paid|sent|payment|amount|debited)\b"#, options: .regularExpression) != nil,
               line.range(of: #"\b\d{1,2}[:/-]\d{1,2}"#, options: .regularExpression) == nil,
               let plainRange = line.range(of: #"\b[0-9][0-9,]*(?:\.[0-9]{1,2})?\b"#, options: .regularExpression),
               let value = amount(from: String(line[plainRange])), value > 0 {
                candidates.append((value, 6))
            }
        }
        // Paytm occasionally places the currency symbol and value in separate
        // OCR observations. Score those adjacent lines as one amount.
        for index in 0..<max(0, lines.count - 1) where lines[index].trimmingCharacters(in: .whitespaces) == "₹" {
            if let value = amount(from: lines[index + 1]), value > 0 { candidates.append((value, 7)) }
        }
        return candidates.max { lhs, rhs in lhs.score == rhs.score ? lhs.value < rhs.value : lhs.score < rhs.score }?.value
    }

    private struct Timestamp { let date: Date; let timeVerified: Bool }

    private static func bestTimestamp(in lines: [String], now: Date = .now) -> Timestamp? {
        let joined = lines.joined(separator: " ")
            .replacingOccurrences(of: #"(?i)\bat\b"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        let candidates = [joined] + lines + zip(lines, lines.dropFirst()).map { "\($0.0) \($0.1)" }
        let calendar = Calendar(identifier: .gregorian)
        let timezone = TimeZone(identifier: "Asia/Kolkata") ?? .current

        func parse(_ raw: String, formats: [String], hasTime: Bool) -> Timestamp? {
            let cleaned = raw.trimmingCharacters(in: CharacterSet(charactersIn: " ,|·"))
            for format in formats {
                let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = timezone; formatter.dateFormat = format; formatter.isLenient = false
                if var date = formatter.date(from: cleaned) {
                    if !format.contains("y") {
                        let currentYear = calendar.component(.year, from: now)
                        date = calendar.date(bySetting: .year, value: currentYear, of: date) ?? date
                        if date.timeIntervalSince(now) > 7 * 86_400 { date = calendar.date(byAdding: .year, value: -1, to: date) ?? date }
                    }
                    if !hasTime { date = calendar.date(bySettingHour: 12, minute: 0, second: 0, of: date) ?? date }
                    return Timestamp(date: date, timeVerified: hasTime)
                }
            }
            return nil
        }

        let patterns: [(String, [String], Bool)] = [
            (#"(?i)\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}[, ]+\d{1,2}:\d{2}(?::\d{2})?\s*[AP]M\b"#, ["d MMM yyyy, h:mm a", "d MMMM yyyy, h:mm a", "d MMM yyyy h:mm a", "d MMMM yyyy h:mm a", "d MMM yyyy, h:mm:ss a"], true),
            (#"(?i)\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[,]?\s+\d{1,2}:\d{2}\s*[AP]M\b"#, ["d MMM, h:mm a", "d MMMM, h:mm a", "d MMM h:mm a", "d MMMM h:mm a"], true),
            (#"(?i)\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}[, ]+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]M)?\b"#, ["d/M/yyyy, H:mm", "d-M-yyyy, H:mm", "d/M/yy, h:mm a", "d-M-yy, h:mm a", "d/M/yyyy h:mm a", "d-M-yyyy h:mm a", "d/M/yyyy H:mm:ss"], true),
            (#"(?i)\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\b"#, ["d MMM yyyy", "d MMMM yyyy"], false),
            (#"\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b"#, ["d/M/yyyy", "d-M-yyyy", "d/M/yy", "d-M-yy"], false)
        ]
        for candidate in candidates {
            for (pattern, formats, hasTime) in patterns {
                guard let range = candidate.range(of: pattern, options: [.regularExpression, .caseInsensitive]) else { continue }
                let raw = String(candidate[range]).replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
                if let timestamp = parse(raw, formats: formats, hasTime: hasTime) { return timestamp }
            }
        }
        return nil
    }

    private static func bestMerchant(in lines: [String]) -> String {
        if let urlLine = lines.first(where: { $0.hasPrefix("http://") || $0.hasPrefix("https://") }),
           let host = URL(string: urlLine)?.host {
            return host.replacingOccurrences(of: "www.", with: "")
        }
        let prefixes = ["paid to", "sent to", "payment to", "transferred to", "merchant", "to:"]
        for (index, line) in lines.enumerated() {
            let lower = line.lowercased()
            if lower == "to", lines.indices.contains(index + 1), isMerchantCandidate(lines[index + 1]) { return cleanMerchant(lines[index + 1]) }
            for prefix in prefixes where lower.contains(prefix) {
                let start = lower.range(of: prefix)!.upperBound
                let candidate = cleanMerchant(String(line[start...]))
                if !candidate.isEmpty { return candidate }
                if lines.indices.contains(index + 1), isMerchantCandidate(lines[index + 1]) { return cleanMerchant(lines[index + 1]) }
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

    private static func isMerchantCandidate(_ line: String) -> Bool {
        let lower = line.lowercased()
        let noise = ["payment", "successful", "completed", "transaction", "upi", "bank", "date", "time", "done", "pay again", "share"]
        return !line.contains("₹") && amount(from: line) == nil && line.count >= 2 && line.count <= 80 && !noise.contains(where: { lower == $0 || lower.hasPrefix("\($0) ") })
    }

    private static func suggestedCategory(for merchant: String) -> String {
        let value = merchant.lowercased()
        if value.range(of: "zomato|swiggy|restaurant|cafe|food", options: .regularExpression) != nil { return "Food & dining" }
        if value.range(of: "blinkit|zepto|grocery|bigbasket|instamart", options: .regularExpression) != nil { return "Groceries" }
        if value.range(of: "uber|ola|metro|fuel|petrol|toll|parking", options: .regularExpression) != nil { return "Travel" }
        if value.range(of: "amazon|flipkart|myntra|ajio", options: .regularExpression) != nil { return "Shopping" }
        return "Uncategorised"
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
    static let paisaCanvas = UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 16 / 255, green: 24 / 255, blue: 21 / 255, alpha: 1) : UIColor(red: 246 / 255, green: 243 / 255, blue: 236 / 255, alpha: 1) }
    static let paisaSurface = UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 23 / 255, green: 35 / 255, blue: 31 / 255, alpha: 1) : UIColor(red: 252 / 255, green: 250 / 255, blue: 245 / 255, alpha: 1) }
    static let paisaForest = UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 132 / 255, green: 194 / 255, blue: 171 / 255, alpha: 1) : UIColor(red: 23 / 255, green: 61 / 255, blue: 53 / 255, alpha: 1) }
    static let paisaAccent = paisaForest
    static let paisaPrimaryForeground = UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 13 / 255, green: 35 / 255, blue: 29 / 255, alpha: 1) : .white }
    static let paisaInk = UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 237 / 255, green: 243 / 255, blue: 239 / 255, alpha: 1) : UIColor(red: 24 / 255, green: 35 / 255, blue: 31 / 255, alpha: 1) }
    static let paisaMuted = UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 174 / 255, green: 187 / 255, blue: 180 / 255, alpha: 1) : UIColor(red: 103 / 255, green: 110 / 255, blue: 103 / 255, alpha: 1) }
    static let paisaLine = UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 52 / 255, green: 68 / 255, blue: 61 / 255, alpha: 1) : UIColor(red: 219 / 255, green: 216 / 255, blue: 207 / 255, alpha: 1) }
}
