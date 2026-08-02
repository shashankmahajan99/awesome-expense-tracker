import SwiftUI
import SwiftData
import UniformTypeIdentifiers
import PDFKit

struct StatementImportView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @State private var showPicker = false
    @State private var loading = false
    @State private var rows: [StatementRow] = []
    @State private var message = "PDF and CSV files are parsed on this iPhone. The original file is not stored."

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                Image(systemName: "doc.text.magnifyingglass").font(.system(size: 44)).foregroundStyle(.green)
                Text("Import a bank statement").font(.title2.bold())
                Text(message).multilineTextAlignment(.center).foregroundStyle(.secondary)
                if loading { ProgressView("Reading statement…") }
                if !rows.isEmpty {
                    List(rows) { row in HStack { VStack(alignment: .leading) { Text(row.merchant).lineLimit(1); Text(row.date, style: .date).font(.caption).foregroundStyle(.secondary) }; Spacer(); Text(PaisaFormat.amount(row.amount)).bold() } }.listStyle(.plain)
                    Button("Import \(rows.count) transactions") { rows.forEach { context.insert(PaisaTransaction(merchant: $0.merchant, amount: $0.amount, occurredAt: $0.date, source: "bank_statement")) }; dismiss() }.buttonStyle(.borderedProminent)
                } else if !loading { Button("Choose PDF or CSV") { showPicker = true }.buttonStyle(.borderedProminent).controlSize(.large) }
                Spacer()
            }.padding().navigationTitle("Statement import").navigationBarTitleDisplayMode(.inline).toolbar { Button("Close") { dismiss() } }
        }
        .fileImporter(isPresented: $showPicker, allowedContentTypes: [.pdf, .commaSeparatedText, .plainText]) { result in
            guard case .success(let url) = result else { return }; Task { await read(url) }
        }
    }

    @MainActor private func read(_ url: URL) async {
        loading = true; defer { loading = false }
        guard url.startAccessingSecurityScopedResource() else { message = "Paisa could not access this file."; return }
        defer { url.stopAccessingSecurityScopedResource() }
        do {
            let text: String
            if url.pathExtension.lowercased() == "pdf" { guard let pdf = PDFDocument(url: url) else { throw ImportError.unreadable }; text = (0..<pdf.pageCount).compactMap { pdf.page(at: $0)?.string }.joined(separator: "\n") }
            else { text = try String(contentsOf: url, encoding: .utf8) }
            rows = StatementParser.parse(text); message = rows.isEmpty ? "No transaction rows were detected. Try a selectable-text PDF or a CSV with date, description, and amount." : "Review the detected payments before importing."
        } catch { message = "This statement could not be read. Password-protected PDFs can be unlocked in Files first." }
    }
}

struct StatementRow: Identifiable { let id = UUID(); let date: Date; let merchant: String; let amount: Double }
enum ImportError: Error { case unreadable }

enum StatementParser {
    static func parse(_ text: String) -> [StatementRow] {
        text.components(separatedBy: .newlines).compactMap { line in
            let datePattern = #"\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b"#
            let amountPattern = #"(?:₹|INR|Rs\.?)?\s*([0-9][0-9,]*\.\d{2})(?:\s|$|Cr|Dr)"#
            guard let dateRegex = try? NSRegularExpression(pattern: datePattern), let amountRegex = try? NSRegularExpression(pattern: amountPattern) else { return nil }
            let range = NSRange(line.startIndex..., in: line); guard let dateMatch = dateRegex.firstMatch(in: line, range: range), let amountMatch = amountRegex.matches(in: line, range: range).last,
                  let d1 = Range(dateMatch.range(at: 1), in: line), let d2 = Range(dateMatch.range(at: 2), in: line), let d3 = Range(dateMatch.range(at: 3), in: line), let amountRange = Range(amountMatch.range(at: 1), in: line) else { return nil }
            let yearText = String(line[d3]); var parts = DateComponents(); parts.day = Int(line[d1]); parts.month = Int(line[d2]); parts.year = Int(yearText.count == 2 ? "20\(yearText)" : yearText); parts.hour = 12
            guard let date = Calendar.current.date(from: parts), let amount = Double(line[amountRange].replacingOccurrences(of: ",", with: "")), amount > 0 else { return nil }
            let merchant = line.replacingOccurrences(of: String(line[Range(dateMatch.range, in: line)!]), with: "").replacingOccurrences(of: String(line[Range(amountMatch.range, in: line)!]), with: "").trimmingCharacters(in: .whitespacesAndNewlines)
            return merchant.isEmpty ? nil : StatementRow(date: date, merchant: String(merchant.prefix(160)), amount: amount)
        }
    }
}
