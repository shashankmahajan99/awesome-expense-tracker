import AppIntents
import Foundation

struct ImportBankSMSIntent: AppIntent {
    static var title: LocalizedStringResource = "Add Bank SMS to Paisa Inbox"
    static var description = IntentDescription("Extracts a debit transaction locally from bank SMS text and adds it to the Paisa Inbox review queue.")
    static var openAppWhenRun = true

    @Parameter(title: "Bank SMS") var message: String
    @Parameter(title: "Payment account", description: "Choose one of your saved banks, cards, wallets, or payment apps.") var account: PaymentAccountEntity?

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let transaction = BankSMSParser.parse(message) else { return .result(dialog: "I couldn’t find a debit amount and merchant. Pass the full bank message and try again.") }
        let receipt = SharedReceipt(id: UUID(), merchant: transaction.merchant, amount: transaction.amount, category: transaction.category, note: "Imported from bank SMS · \(message.prefix(240))", occurredAt: transaction.date, createdAt: .now, accountTag: account?.name)
        try SharedInbox.save(receipt)
        return .result(dialog: "Added \(transaction.merchant) for ₹\(transaction.amount.formatted(.number.precision(.fractionLength(0...2)))) to your review inbox.")
    }
}

struct PaymentAccountEntity: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Payment account")
    static var defaultQuery = PaymentAccountQuery()

    let id: UUID
    let name: String
    let subtitle: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)", subtitle: "\(subtitle)") }

    init(_ account: SharedPaymentAccount) {
        id = account.id
        name = account.name
        subtitle = [account.kind.capitalized, account.institution, account.lastFour.isEmpty ? "" : "•••• \(account.lastFour)"].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

struct PaymentAccountQuery: EntityQuery {
    func entities(for identifiers: [UUID]) async throws -> [PaymentAccountEntity] {
        SharedPaymentAccountDirectory.all().filter { identifiers.contains($0.id) }.map(PaymentAccountEntity.init)
    }

    func suggestedEntities() async throws -> [PaymentAccountEntity] {
        SharedPaymentAccountDirectory.all().map(PaymentAccountEntity.init)
    }
}

struct PaisaShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ImportBankSMSIntent(), phrases: ["Add bank message to \(.applicationName)", "Import bank SMS into \(.applicationName)"], shortTitle: "Add bank SMS", systemImageName: "message.badge.fill")
    }
}

private enum BankSMSParser {
    struct Result { let merchant: String; let amount: Double; let date: Date; let category: String }
    static func parse(_ message: String) -> Result? {
        let debitSignal = message.range(of: #"(?i)\b(debited|spent|paid|purchase|withdrawn|txn|transaction)\b"#, options: .regularExpression) != nil
        guard debitSignal, let amountRange = message.range(of: #"(?i)(?:₹|INR|Rs\.?)[\s:]*[0-9][0-9,]*(?:\.[0-9]{1,2})?"#, options: .regularExpression) else { return nil }
        let amountText = String(message[amountRange]).replacingOccurrences(of: #"[^0-9.]"#, with: "", options: .regularExpression)
        guard let amount = Double(amountText), amount > 0 else { return nil }
        let merchantPatterns = [#"(?i)\b(?:at|to|towards)\s+([A-Z0-9][A-Z0-9 &._-]{2,60}?)(?=\s+(?:on|using|via|ref|avl|available|from)\b|[.,]|$)"#, #"(?i)\bUPI[-/ ](?:P2M|P2P)[-/ ]+([A-Z0-9][A-Z0-9 &._-]{2,50})"#]
        var merchant = "Bank payment"
        for pattern in merchantPatterns {
            guard let regex = try? NSRegularExpression(pattern: pattern), let match = regex.firstMatch(in: message, range: NSRange(message.startIndex..., in: message)), let range = Range(match.range(at: 1), in: message) else { continue }
            merchant = String(message[range]).replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines); break
        }
        let category = category(for: merchant)
        return Result(merchant: merchant, amount: amount, date: date(in: message) ?? .now, category: category)
    }
    private static func date(in value: String) -> Date? {
        guard let range = value.range(of: #"\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}(?:\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?\b"#, options: [.regularExpression, .caseInsensitive]) else { return nil }
        for format in ["dd/MM/yy hh:mm a", "dd-MM-yy hh:mm a", "dd/MM/yyyy HH:mm", "dd-MM-yyyy HH:mm", "dd/MM/yy", "dd-MM-yy", "dd/MM/yyyy", "dd-MM-yyyy"] { let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_IN_POSIX"); formatter.dateFormat = format; if let parsed = formatter.date(from: String(value[range])) { return parsed } }
        return nil
    }
    private static func category(for merchant: String) -> String { let value = merchant.lowercased(); if value.range(of: "zomato|swiggy|restaurant|cafe", options: .regularExpression) != nil { return "Food & dining" }; if value.range(of: "blinkit|zepto|grocery", options: .regularExpression) != nil { return "Groceries" }; if value.range(of: "uber|ola|metro|fuel|petrol|toll", options: .regularExpression) != nil { return "Travel" }; return "Uncategorised" }
}
