import Foundation

struct SharedReceipt: Codable, Identifiable {
    let id: UUID
    let merchant: String
    let amount: Double
    let category: String
    let note: String
    let occurredAt: Date
    let createdAt: Date
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
