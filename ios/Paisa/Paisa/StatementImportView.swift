import SwiftUI
import SwiftData
import UniformTypeIdentifiers
@preconcurrency import PDFKit
@preconcurrency import Vision

struct StatementImportView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @EnvironmentObject private var sync: SyncManager
    @State private var showPicker = false
    @State private var loading = false
    @State private var files: [ImportFileProgress] = []
    @State private var rows: [StatementRow] = []
    @State private var message = "PDF and CSV files are parsed on this iPhone. The original files are never uploaded or stored."

    private var overallProgress: Double {
        guard !files.isEmpty else { return 0 }
        return files.map(\.progress).reduce(0, +) / Double(files.count)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if files.isEmpty && !loading { emptyState }
                else { importState }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 18)
            .background(PaisaTheme.canvas.ignoresSafeArea())
            .navigationTitle("Statement import")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .primaryAction) { Button { showPicker = true } label: { Label("Add files", systemImage: "plus") } }
            }
        }
        .fileImporter(
            isPresented: $showPicker,
            allowedContentTypes: [.pdf, .commaSeparatedText, .tabSeparatedText, .plainText],
            allowsMultipleSelection: true
        ) { result in
            guard case .success(let urls) = result else { return }
            Task { await read(urls) }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "doc.on.doc").font(.system(size: 44)).foregroundStyle(PaisaTheme.forest)
            Text("Import statements together").font(.title2.bold()).foregroundStyle(PaisaTheme.ink)
            Text(message).multilineTextAlignment(.center).foregroundStyle(PaisaTheme.muted)
            Button { showPicker = true } label: { Label("Choose PDFs or CSVs", systemImage: "plus") }
                .buttonStyle(.borderedProminent).tint(PaisaTheme.forest).controlSize(.large)
            Text("Select bank, card, and Paytm statements in one batch. Paisa verifies matching entries instead of counting them twice.")
                .font(.caption).multilineTextAlignment(.center).foregroundStyle(PaisaTheme.muted)
            Spacer()
        }
    }

    private var importState: some View {
        VStack(spacing: 14) {
            if loading {
                PaisaCard {
                    HStack { ProgressView(); Text("Parsing statements").fontWeight(.bold); Spacer(); Text("\(Int(overallProgress * 100))%").monospacedDigit().foregroundStyle(PaisaTheme.muted) }
                    ProgressView(value: overallProgress).tint(PaisaTheme.forest).padding(.top, 10)
                    Text(files.first(where: { $0.status == .parsing })?.detail ?? "Preparing files…")
                        .font(.caption).foregroundStyle(PaisaTheme.muted).padding(.top, 7)
                }
            }

            List {
                Section {
                    ForEach(files.indices, id: \.self) { index in fileRow(index) }
                } header: { Text("Files") }
                if !rows.isEmpty {
                    Section("Detected transactions") {
                        ForEach(rows.prefix(30)) { row in
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(row.merchant).lineLimit(1).fontWeight(.semibold)
                                    Text("\(row.date.formatted(.dateTime.day().month().year())) · \(row.accountTag)").font(.caption).foregroundStyle(PaisaTheme.muted).lineLimit(1)
                                }
                                Spacer()
                                Text(PaisaFormat.amount(row.amount)).bold()
                            }
                        }
                        if rows.count > 30 { Text("Plus \(rows.count - 30) more transactions").font(.caption).foregroundStyle(PaisaTheme.muted) }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)

            if !loading {
                VStack(spacing: 9) {
                    Text(message).font(.caption).foregroundStyle(PaisaTheme.muted).multilineTextAlignment(.center)
                    Button("Import \(rows.count) transactions") { importRows() }
                        .buttonStyle(.borderedProminent).tint(PaisaTheme.forest).controlSize(.large)
                        .frame(maxWidth: .infinity).disabled(rows.isEmpty)
                }
            }
        }
    }

    @ViewBuilder
    private func fileRow(_ index: Int) -> some View {
        let file = files[index]
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                Image(systemName: file.status.icon).foregroundStyle(file.status.color)
                VStack(alignment: .leading, spacing: 3) {
                    Text(file.name).fontWeight(.semibold).lineLimit(1)
                    Text(file.detail).font(.caption).foregroundStyle(PaisaTheme.muted)
                }
                Spacer()
                if file.status == .parsing { ProgressView().controlSize(.small) }
            }
            if file.status == .ready {
                TextField("Account tag", text: Binding(
                    get: { files[index].accountTag },
                    set: { value in
                        files[index].accountTag = value
                        for rowIndex in rows.indices where rows[rowIndex].sourceFile == files[index].name { rows[rowIndex].accountTag = value }
                    }
                ))
                .textInputAutocapitalization(.words)
                .font(.subheadline)
            }
        }
        .padding(.vertical, 4)
    }

    @MainActor
    private func read(_ urls: [URL]) async {
        guard !urls.isEmpty else { return }
        loading = true
        rows = []
        files = urls.map { ImportFileProgress(name: $0.lastPathComponent) }
        defer { loading = false }

        for (index, url) in urls.enumerated() {
            files[index].status = .parsing
            files[index].detail = "Opening \(url.lastPathComponent)…"
            let didAccess = url.startAccessingSecurityScopedResource()
            defer { if didAccess { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url, options: [.mappedIfSafe])
                let isPDF = url.pathExtension.lowercased() == "pdf" || data.starts(with: Data("%PDF".utf8))
                let parsed: StatementParseResult
                if isPDF {
                    parsed = try await StatementDocumentParser.parsePDF(data: data, filename: url.lastPathComponent) { progress, detail in
                        files[index].progress = progress
                        files[index].detail = detail
                    }
                } else {
                    files[index].detail = "Reading rows from \(url.lastPathComponent)…"
                    parsed = try StatementDocumentParser.parseCSV(data: data, filename: url.lastPathComponent)
                }
                rows.append(contentsOf: parsed.rows)
                files[index].progress = 1
                files[index].status = parsed.rows.isEmpty ? .failed : .ready
                files[index].accountTag = parsed.accountTag
                files[index].detail = parsed.rows.isEmpty
                    ? "No debit transactions detected"
                    : "\(parsed.rows.count) debits · \(PaisaFormat.amount(parsed.rows.reduce(0) { $0 + $1.amount }))"
            } catch let error as StatementImportError {
                files[index].progress = 1; files[index].status = .failed; files[index].detail = error.localizedDescription
            } catch {
                files[index].progress = 1; files[index].status = .failed; files[index].detail = "Could not read this file"
            }
        }
        let failed = files.filter { $0.status == .failed }.count
        message = rows.isEmpty
            ? "No debit rows were found. Password-protected PDFs must be unlocked before importing."
            : "\(rows.count) payments are ready across \(files.count - failed) files\(failed > 0 ? "; \(failed) could not be parsed" : ""). You can edit every account tag before importing."
    }

    private func importRows() {
        do {
            let existing = try context.fetch(FetchDescriptor<PaisaTransaction>())
            let summary = StatementTransactionMerger.merge(rows: rows, into: existing, context: context)
            try context.save()
            Task { await sync.syncIfConnected(context: context) }
            message = "Imported \(summary.inserted) new payments and verified \(summary.verified) cross-statement duplicates."
            dismiss()
        } catch {
            message = "The transactions could not be saved. Your selected files were not changed."
        }
    }
}

struct StatementRow: Identifiable {
    let id = UUID()
    let date: Date
    let timeVerified: Bool
    let merchant: String
    let amount: Double
    var accountTag: String
    let sourceFile: String
    let sourceKind: String
    let reference: String
}

struct ImportFileProgress {
    enum Status {
        case waiting, parsing, ready, failed
        var icon: String { switch self { case .waiting: "clock"; case .parsing: "doc.text.magnifyingglass"; case .ready: "checkmark.circle.fill"; case .failed: "exclamationmark.triangle.fill" } }
        var color: Color { switch self { case .ready: PaisaTheme.forest; case .failed: .orange; default: PaisaTheme.muted } }
    }
    let name: String
    var accountTag = ""
    var status: Status = .waiting
    var progress = 0.0
    var detail = "Waiting to parse"
}

struct StatementParseResult { let rows: [StatementRow]; let accountTag: String }

enum StatementImportError: LocalizedError {
    case unreadable, locked, noText
    var errorDescription: String? {
        switch self {
        case .unreadable: "The file is damaged or uses an unsupported format"
        case .locked: "Password-protected PDF — unlock it in Files first"
        case .noText: "No readable statement text was found"
        }
    }
}

enum StatementDocumentParser {
    @MainActor
    static func parsePDF(data: Data, filename: String, progress: (Double, String) -> Void) async throws -> StatementParseResult {
        guard let document = PDFDocument(data: data) else { throw StatementImportError.unreadable }
        if document.isLocked { throw StatementImportError.locked }
        guard document.pageCount > 0 else { throw StatementImportError.noText }
        var lines: [String] = []
        for pageIndex in 0..<document.pageCount {
            let pageNumber = pageIndex + 1
            progress(Double(pageIndex) / Double(document.pageCount), "Reading \(filename) · page \(pageNumber) of \(document.pageCount)")
            guard let page = document.page(at: pageIndex) else { continue }
            let selectable = page.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if selectable.count > 20 {
                lines.append(contentsOf: selectable.components(separatedBy: .newlines))
            } else if let cgImage = page.thumbnail(of: CGSize(width: 1800, height: 2400), for: .mediaBox).cgImage,
                      let recognized = await recognizeText(cgImage) {
                lines.append(contentsOf: recognized.components(separatedBy: .newlines))
            }
            progress(Double(pageNumber) / Double(document.pageCount), "Parsed \(filename) · page \(pageNumber) of \(document.pageCount) · \(lines.count) text rows")
        }
        guard !lines.isEmpty else { throw StatementImportError.noText }
        let accountTag = AccountTagDetector.detect(filename: filename, text: lines.prefix(80).joined(separator: " "))
        return StatementParseResult(rows: parseStatementLines(lines, filename: filename, accountTag: accountTag), accountTag: accountTag)
    }

    static func parseCSV(data: Data, filename: String) throws -> StatementParseResult {
        guard let text = decodeText(data) else { throw StatementImportError.unreadable }
        let table = delimitedRows(text)
        guard table.count > 1 else { throw StatementImportError.noText }
        let headers = table[0].map(normalizeHeader)
        func column(_ names: String...) -> Int? { headers.firstIndex { header in names.contains(where: { header == $0 || header.contains($0) }) } }
        let dateColumn = column("date", "transactiondate", "valuedate", "datetime")
        let merchantColumn = column("merchant", "description", "narration", "payee", "details", "transactiondetails")
        let debitColumn = column("debit", "withdrawal", "debitamount", "withdrawalamount")
        let creditColumn = column("credit", "deposit", "creditamount")
        let amountColumn = column("amount", "transactionamount")
        let typeColumn = column("type", "drcr", "transactiontype")
        let referenceColumn = column("reference", "transactionid", "utr", "refno", "orderid")
        guard let merchantColumn, debitColumn != nil || amountColumn != nil else { throw StatementImportError.noText }
        let accountTag = AccountTagDetector.detect(filename: filename, text: table.prefix(8).flatMap { $0 }.joined(separator: " "))
        let source = sourceKind(filename: filename, accountTag: accountTag)
        var parsed: [StatementRow] = []
        for values in table.dropFirst() {
            func value(_ index: Int?) -> String { guard let index, values.indices.contains(index) else { return "" }; return values[index].trimmingCharacters(in: .whitespacesAndNewlines) }
            let merchant = cleanMerchant(value(merchantColumn))
            guard let date = parseDateInfo(value(dateColumn)) else { continue }
            let debit = parseAmount(value(debitColumn))
            let amount = debit ?? parseAmount(value(amountColumn))
            let type = value(typeColumn).lowercased()
            let hasCreditOnly = debit == nil && creditColumn != nil && parseAmount(value(creditColumn)) != nil
            guard !merchant.isEmpty, let amount, amount > 0, !hasCreditOnly, !type.contains("cr"), !type.contains("credit") else { continue }
            parsed.append(StatementRow(date: date.date, timeVerified: date.timeVerified, merchant: merchant, amount: amount, accountTag: accountTag, sourceFile: filename, sourceKind: source, reference: value(referenceColumn)))
        }
        return StatementParseResult(rows: parsed, accountTag: accountTag)
    }

    static func parseStatementLines(_ lines: [String], filename: String, accountTag: String) -> [StatementRow] {
        let ignored = try? NSRegularExpression(pattern: "opening balance|closing balance|available balance|total debit|total credit|statement summary|account number|customer id|date narration", options: .caseInsensitive)
        let amountRegex = try? NSRegularExpression(pattern: #"(?:₹|INR|Rs\.?)?\s*([0-9][0-9,]*(?:\.\d{1,2}))(?=\s|$|Cr|Dr|\|)"#, options: .caseInsensitive)
        let referenceRegex = try? NSRegularExpression(pattern: #"(?i)(?:UTR|UPI ref|reference|ref no|transaction id|order id)[:\s-]*([A-Z0-9-]{6,40})"#)
        let source = sourceKind(filename: filename, accountTag: accountTag)
        var output: [StatementRow] = []
        for raw in lines {
            let line = raw.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
            guard let date = parseDateInfo(line), line.count > 8 else { continue }
            let fullRange = NSRange(line.startIndex..., in: line)
            if ignored?.firstMatch(in: line, range: fullRange) != nil { continue }
            if line.range(of: #"\b(?:CR|credit|deposit)\b"#, options: [.regularExpression, .caseInsensitive]) != nil,
               line.range(of: #"\b(?:DR|debit|withdrawal|paid|sent)\b"#, options: [.regularExpression, .caseInsensitive]) == nil { continue }
            let matches = amountRegex?.matches(in: line, range: fullRange) ?? []
            let amounts = matches.compactMap { match -> (Double, Range<String.Index>)? in
                guard let capture = Range(match.range(at: 1), in: line), let whole = Range(match.range, in: line), let value = parseAmount(String(line[capture])) else { return nil }
                return (value, whole)
            }.filter { $0.0 > 0 && $0.0 < 100_000_000 }
            guard let selected = amounts.first else { continue }
            var merchant = line
            if let dateRange = dateTextRange(in: merchant) { merchant.removeSubrange(dateRange) }
            merchant = merchant.replacingOccurrences(of: #"(?:₹|INR|Rs\.?)?\s*[0-9][0-9,]*(?:\.\d{1,2})(?=\s|$|Cr|Dr|\|)"#, with: " ", options: [.regularExpression, .caseInsensitive])
            merchant = cleanMerchant(merchant.replacingOccurrences(of: #"\b(?:DR|CR|debit|credit|withdrawal)\b"#, with: " ", options: [.regularExpression, .caseInsensitive]))
            guard !merchant.isEmpty, !merchant.allSatisfy(\.isNumber) else { continue }
            let reference: String
            if let match = referenceRegex?.firstMatch(in: line, range: fullRange), let range = Range(match.range(at: 1), in: line) { reference = String(line[range]) }
            else { reference = "" }
            output.append(StatementRow(date: date.date, timeVerified: date.timeVerified, merchant: String(merchant.prefix(160)), amount: selected.0, accountTag: accountTag, sourceFile: filename, sourceKind: source, reference: reference))
        }
        return output
    }

    private static func recognizeText(_ image: CGImage) async -> String? {
        await withCheckedContinuation { continuation in
            let request = VNRecognizeTextRequest { request, _ in
                continuation.resume(returning: (request.results as? [VNRecognizedTextObservation] ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n"))
            }
            request.recognitionLevel = .accurate; request.recognitionLanguages = ["en-IN", "en-US"]; request.usesLanguageCorrection = true
            DispatchQueue.global(qos: .userInitiated).async {
                do { try VNImageRequestHandler(cgImage: image).perform([request]) } catch { continuation.resume(returning: nil) }
            }
        }
    }

    private static func decodeText(_ data: Data) -> String? {
        [.utf8, .utf16, .utf16LittleEndian, .utf16BigEndian, .windowsCP1252, .isoLatin1].compactMap { String(data: data, encoding: $0) }.first
    }

    private static func delimitedRows(_ text: String) -> [[String]] {
        let sample = text.components(separatedBy: .newlines).prefix(5).joined(separator: "\n")
        let delimiter = [",", "\t", ";", "|"].max { lhs, rhs in sample.filter { String($0) == lhs }.count < sample.filter { String($0) == rhs }.count } ?? ","
        var rows: [[String]] = [], row: [String] = [], field = ""; var quoted = false
        let characters = Array(text); var index = 0
        while index < characters.count {
            let character = characters[index]
            if character == "\"" && quoted && index + 1 < characters.count && characters[index + 1] == "\"" { field.append("\""); index += 1 }
            else if character == "\"" { quoted.toggle() }
            else if String(character) == delimiter && !quoted { row.append(field); field = "" }
            else if (character == "\n" || character == "\r") && !quoted {
                if character == "\r" && index + 1 < characters.count && characters[index + 1] == "\n" { index += 1 }
                row.append(field); if row.contains(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) { rows.append(row) }; row = []; field = ""
            } else { field.append(character) }
            index += 1
        }
        row.append(field); if row.contains(where: { !$0.isEmpty }) { rows.append(row) }
        return rows
    }

    private static func normalizeHeader(_ value: String) -> String { value.lowercased().filter(\.isLetter) }
    private static func parseAmount(_ value: String) -> Double? {
        let cleaned = value.replacingOccurrences(of: ",", with: "").replacingOccurrences(of: #"[^0-9.\-]"#, with: "", options: .regularExpression)
        guard let number = Double(cleaned), number > 0 else { return nil }; return number
    }

    private static let dateFormats = ["dd/MM/yyyy", "dd-MM-yyyy", "dd/MM/yy", "dd-MM-yy", "dd MMM yyyy", "dd-MMM-yyyy", "yyyy-MM-dd", "MM/dd/yyyy"]
    private struct ParsedDate { let date: Date; let timeVerified: Bool }
    private static func parseDateInfo(_ value: String) -> ParsedDate? {
        if let iso = ISO8601DateFormatter().date(from: value), value.range(of: #"[T ]\d{1,2}:\d{2}"#, options: .regularExpression) != nil { return ParsedDate(date: iso, timeVerified: true) }
        for format in dateFormats {
            let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_IN_POSIX"); formatter.dateFormat = format; formatter.isLenient = false
            if let match = value.range(of: dateRegex(for: format), options: [.regularExpression, .caseInsensitive]), let date = formatter.date(from: String(value[match])) {
                if let timeRange = value.range(of: #"\b(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\s*[AP]M)?\b"#, options: [.regularExpression, .caseInsensitive]) {
                    let raw = String(value[timeRange]).uppercased().replacingOccurrences(of: " ", with: "")
                    let components = raw.replacingOccurrences(of: "AM", with: "").replacingOccurrences(of: "PM", with: "").split(separator: ":").compactMap { Int($0) }
                    guard components.count >= 2 else { continue }
                    var hour = components[0]; if raw.hasSuffix("PM") && hour < 12 { hour += 12 }; if raw.hasSuffix("AM") && hour == 12 { hour = 0 }
                    if let precise = Calendar.current.date(bySettingHour: hour, minute: components[1], second: components.count > 2 ? components[2] : 0, of: date) { return ParsedDate(date: precise, timeVerified: true) }
                }
                if let noon = Calendar.current.date(bySettingHour: 12, minute: 0, second: 0, of: date) { return ParsedDate(date: noon, timeVerified: false) }
            }
        }
        return nil
    }

    private static func dateRegex(for format: String) -> String {
        if format.hasPrefix("yyyy") { return #"\b\d{4}-\d{1,2}-\d{1,2}\b"# }
        if format.contains("MMM") { return #"\b\d{1,2}[- ](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[- ]\d{2,4}\b"# }
        let separator = format.contains("/") ? "/" : "-"; return #"\b\d{1,2}"# + separator + #"\d{1,2}"# + separator + #"\d{2,4}\b"#
    }

    private static func dateTextRange(in value: String) -> Range<String.Index>? {
        value.range(of: #"\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}[- ](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[- ]\d{2,4})\b"#, options: [.regularExpression, .caseInsensitive])
    }

    private static func cleanMerchant(_ value: String) -> String {
        value.replacingOccurrences(of: #"(?i)\b(?:UPI|IMPS|NEFT|POS|ECOM|VPS|IPS|ATM|REF|TXN)\b[:/ -]*"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: " |:/-"))
    }

    private static func sourceKind(filename: String, accountTag: String) -> String {
        let value = "\(filename) \(accountTag)".lowercased()
        if value.contains("paytm") { return filename.lowercased().hasSuffix(".pdf") ? "paytm_pdf" : "paytm_csv" }
        return filename.lowercased().hasSuffix(".pdf") ? "bank_pdf" : "bank_csv"
    }
}

enum AccountTagDetector {
    static func detect(filename: String, text: String) -> String {
        let value = "\(filename) \(text)".lowercased()
        let bank = [("icici", "ICICI"), ("hdfc", "HDFC"), ("axis", "Axis"), ("sbi", "SBI"), ("kotak", "Kotak"), ("yes bank", "YES Bank")].first(where: { value.contains($0.0) })?.1
        if value.contains("paytm") { return bank.map { "Paytm - Savings \($0)" } ?? "Paytm Wallet" }
        if value.contains("rupay") { return bank.map { "RuPay Card - \($0)" } ?? "RuPay Card" }
        if value.contains("credit card") || value.contains("card statement") { return bank.map { "Credit Card - \($0)" } ?? "Credit Card" }
        return bank.map { "Savings - \($0)" } ?? "Bank account"
    }
}

enum StatementTransactionMerger {
    struct Summary { let inserted: Int; let verified: Int; let skipped: Int }

    static func merge(rows: [StatementRow], into existing: [PaisaTransaction], context: ModelContext) -> Summary {
        var candidates = existing.filter { !$0.isDeleted }
        var inserted = 0, verified = 0, skipped = 0
        for row in rows {
            if let match = candidates.first(where: { isDuplicate($0, row) }) {
                let crossSource = sourceSet(match.source).isDisjoint(with: sourceSet(row.sourceKind))
                match.source = joinedSources(match.source, row.sourceKind)
                match.accountTag = combinedTag(match.accountTag, row.accountTag)
                if row.timeVerified && !match.timeVerified { match.occurredAt = row.date; match.timeVerified = true }
                if crossSource {
                    let verification = "Verified in \(match.accountTag)"
                    if !match.note.contains(verification) { match.note = [match.note, verification].filter { !$0.isEmpty }.joined(separator: " · ") }
                    match.updatedAt = .now; verified += 1
                } else { skipped += 1 }
                continue
            }
            let noteParts = [row.reference.isEmpty ? nil : "Reference: \(row.reference)", "Imported from \(row.sourceFile)"].compactMap { $0 }
            let transaction = PaisaTransaction(merchant: row.merchant, amount: row.amount, occurredAt: row.date, timeVerified: row.timeVerified, note: noteParts.joined(separator: " · "), source: row.sourceKind, accountTag: row.accountTag)
            context.insert(transaction); candidates.append(transaction); inserted += 1
        }
        return Summary(inserted: inserted, verified: verified, skipped: skipped)
    }

    private static func isDuplicate(_ item: PaisaTransaction, _ row: StatementRow) -> Bool {
        guard abs(item.amount - row.amount) < 0.005, abs(item.occurredAt.timeIntervalSince(row.date)) <= 86_400 else { return false }
        let existingReference = item.note.range(of: #"(?i)Reference:\s*([A-Z0-9-]{6,40})"#, options: .regularExpression).map { String(item.note[$0]).replacingOccurrences(of: "Reference:", with: "", options: .caseInsensitive).trimmingCharacters(in: .whitespaces) } ?? ""
        if !existingReference.isEmpty && !row.reference.isEmpty { return existingReference.caseInsensitiveCompare(row.reference) == .orderedSame }
        let crossSource = sourceSet(item.source).isDisjoint(with: sourceSet(row.sourceKind))
        return crossSource && merchantSimilarity(item.merchant, row.merchant) >= 0.66
    }

    private static func merchantSimilarity(_ lhs: String, _ rhs: String) -> Double {
        func tokens(_ value: String) -> Set<String> { Set(value.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init).filter { $0.count > 2 && !["upi", "paytm", "payment", "transaction", "debit"].contains($0) }) }
        let left = tokens(lhs), right = tokens(rhs); guard !left.isEmpty, !right.isEmpty else { return 0 }
        return Double(left.intersection(right).count) / Double(left.union(right).count)
    }

    private static func sourceSet(_ value: String) -> Set<String> { Set(value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }) }
    private static func joinedSources(_ lhs: String, _ rhs: String) -> String { sourceSet(lhs).union(sourceSet(rhs)).sorted().joined(separator: ",") }
    private static func combinedTag(_ lhs: String, _ rhs: String) -> String {
        if lhs.isEmpty { return rhs }; if rhs.isEmpty || lhs == rhs { return lhs }
        let values = "\(lhs) \(rhs)"
        if values.localizedCaseInsensitiveContains("Paytm"), let bank = ["ICICI", "HDFC", "Axis", "SBI", "Kotak", "YES Bank"].first(where: { values.localizedCaseInsensitiveContains($0) }) { return "Paytm - Savings \(bank)" }
        return Array(Set([lhs, rhs])).sorted().joined(separator: " + ")
    }
}
