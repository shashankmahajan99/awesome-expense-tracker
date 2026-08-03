import Foundation
import CryptoKit

struct SharedReceipt: Codable, Identifiable {
    let id: UUID
    let merchant: String
    let amount: Double
    let category: String
    let note: String
    let occurredAt: Date
    let timeVerified: Bool?
    let createdAt: Date
    let accountTag: String?

    init(id: UUID, merchant: String, amount: Double, category: String, note: String, occurredAt: Date, timeVerified: Bool? = nil, createdAt: Date, accountTag: String? = nil) {
        self.id = id; self.merchant = merchant; self.amount = amount; self.category = category; self.note = note; self.occurredAt = occurredAt; self.timeVerified = timeVerified; self.createdAt = createdAt; self.accountTag = accountTag
    }

    static func captureID(merchant: String, amount: Double, occurredAt: Date, reference: String = "") -> UUID {
        let minute = Int(occurredAt.timeIntervalSince1970 / 60)
        let input = "\(SharedCaptureProfile.normalize(merchant))|\(Int((amount * 100).rounded()))|\(minute)|\(reference.lowercased())"
        var bytes = Array(SHA256.hash(data: Data(input.utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
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

struct SharedCaptureProfile: Codable {
    let lastAccountName: String?
    let categoryByMerchant: [String: String]

    func category(for merchant: String) -> String? {
        let key = Self.normalize(merchant)
        guard !key.isEmpty else { return nil }
        if let exact = categoryByMerchant[key] { return exact }
        return categoryByMerchant.first { stored, _ in key.contains(stored) || stored.contains(key) }?.value
    }

    static func normalize(_ value: String) -> String {
        value.lowercased().replacingOccurrences(of: #"[^a-z0-9]+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum SharedCaptureProfileDirectory {
    private static let key = "paisa.capture-profile"
    private static var defaults: UserDefaults? { UserDefaults(suiteName: SharedInbox.appGroupIdentifier) }

    static func save(_ profile: SharedCaptureProfile) { defaults?.set(try? JSONEncoder().encode(profile), forKey: key) }
    static func current() -> SharedCaptureProfile {
        guard let data = defaults?.data(forKey: key), let profile = try? JSONDecoder().decode(SharedCaptureProfile.self, from: data) else {
            return SharedCaptureProfile(lastAccountName: nil, categoryByMerchant: [:])
        }
        return profile
    }
}

enum SharedAppearance {
    private static let key = "paisa.appearance"
    private static var defaults: UserDefaults? { UserDefaults(suiteName: SharedInbox.appGroupIdentifier) }
    static func save(_ value: String) { defaults?.set(value, forKey: key) }
    static func current() -> String { defaults?.string(forKey: key) ?? "system" }
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
