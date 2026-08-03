import Foundation

struct SharedReceipt: Codable, Identifiable {
    let id: UUID
    let merchant: String
    let amount: Double
    let category: String
    let note: String
    let occurredAt: Date
    let createdAt: Date
    let accountTag: String?

    init(id: UUID, merchant: String, amount: Double, category: String, note: String, occurredAt: Date, createdAt: Date, accountTag: String? = nil) {
        self.id = id; self.merchant = merchant; self.amount = amount; self.category = category; self.note = note; self.occurredAt = occurredAt; self.createdAt = createdAt; self.accountTag = accountTag
    }
}

enum SharedInbox {
    static let appGroupIdentifier = "group.com.shashankmahajan.paisa"

    private static var directoryURL: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)?
            .appending(path: "PendingShares", directoryHint: .isDirectory)
    }

    static func save(_ receipt: SharedReceipt) throws {
        guard let directoryURL else { throw SharedInboxError.containerUnavailable }
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        let data = try JSONEncoder.paisa.encode(receipt)
        try data.write(to: directoryURL.appending(path: "\(receipt.id.uuidString.lowercased()).json"), options: .atomic)
    }

    static func pending() throws -> [SharedReceipt] {
        guard let directoryURL else { throw SharedInboxError.containerUnavailable }
        guard FileManager.default.fileExists(atPath: directoryURL.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )
        .filter { $0.pathExtension == "json" }
        .compactMap { try? JSONDecoder.paisa.decode(SharedReceipt.self, from: Data(contentsOf: $0)) }
        .sorted { $0.createdAt < $1.createdAt }
    }

    static func remove(id: UUID) throws {
        guard let directoryURL else { throw SharedInboxError.containerUnavailable }
        let url = directoryURL.appending(path: "\(id.uuidString.lowercased()).json")
        if FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
    }
}

struct SharedPaymentAccount: Codable, Identifiable, Hashable {
    let id: UUID
    let name: String
    let kind: String
    let institution: String
    let lastFour: String

    var displayName: String { lastFour.isEmpty ? name : "\(name) · •••• \(lastFour)" }
}

enum SharedPaymentAccountDirectory {
    private static let key = "paisa.payment-accounts"
    private static var defaults: UserDefaults? { UserDefaults(suiteName: SharedInbox.appGroupIdentifier) }

    static func save(_ accounts: [SharedPaymentAccount]) {
        defaults?.set(try? JSONEncoder().encode(accounts), forKey: key)
    }

    static func all() -> [SharedPaymentAccount] {
        guard let data = defaults?.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([SharedPaymentAccount].self, from: data)) ?? []
    }
}

private extension JSONEncoder {
    static let paisa: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}

private extension JSONDecoder {
    static let paisa: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

private enum SharedInboxError: LocalizedError {
    case containerUnavailable

    var errorDescription: String? {
        "Paisa Inbox could not access its shared inbox. Reinstall the app and try again."
    }
}
