import Foundation
import Security
import SwiftData
import UIKit

private let paisaAPIBaseURL = URL(string: "https://paisa-daily-inbox.shashankmahajan.chatgpt.site")!

private struct SyncTransaction: Codable {
    let id: String
    let merchant: String
    let amount: Double
    let occurredAt: String
    let timeVerified: Bool?
    let category: String
    let context: String
    let reviewStatus: String
    let source: String
    let accountTag: String?
    let updatedAt: String
    let isDeleted: Bool
}

private struct SyncTombstone: Decodable {
    let id: String
    let deletedAt: String
}

private struct SyncResponse: Decodable {
    let serverTime: String
    let transactions: [SyncTransaction]
    let tombstones: [SyncTombstone]
    let aliases: [String: String]
    let preferences: MobileSyncPreferences?
}

private struct MobileSyncPreferences: Decodable { let reviewTime: String }

private struct APIError: Decodable { let error: String }
private struct ResetResponse: Decodable { let deleted: Int }

@MainActor
final class SyncManager: ObservableObject {
    @Published private(set) var connected: Bool
    @Published private(set) var isWorking = false
    @Published private(set) var status = "Stored only on this iPhone"
    @Published private(set) var lastSynced: Date?
    @Published private(set) var syncCompleted = 0
    @Published private(set) var syncTotal = 0
    @Published private(set) var syncCancellationRequested = false
    @Published private(set) var reviewHour = 21
    @Published private(set) var reviewMinute = 30

    private let tokenService = "com.shashankmahajan.paisa.sync"
    private let tokenAccount = "mobile-access-token"
    private let sitesTokenAccount = "sites-dispatch-token"
    private let pendingStateKey = "paisa.pending-sync-state"
    private let pendingStateDateKey = "paisa.pending-sync-state-created-at"

    init() {
        let hasAccessToken = Self.readKeychain(service: tokenService, account: tokenAccount) != nil
        let hasSitesToken = Self.readKeychain(service: tokenService, account: sitesTokenAccount) != nil
        connected = hasAccessToken && hasSitesToken
        status = connected ? "Connected — ready to sync" : "Stored only on this iPhone"

        // A partial credential pair can never sync. Clear it so Settings always
        // reflects a recoverable state instead of claiming that the app is connected.
        if hasAccessToken != hasSitesToken {
            Self.deleteKeychain(service: tokenService, account: tokenAccount)
            Self.deleteKeychain(service: tokenService, account: sitesTokenAccount)
        }
    }

    func beginPairing() async {
        guard !isWorking else { return }
        syncTotal = 0; syncCompleted = 0; isWorking = true; status = "Opening secure sign-in in Safari…"
        defer { isWorking = false }
        let state = UUID().uuidString
        UserDefaults.standard.set(state, forKey: pendingStateKey)
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: pendingStateDateKey)
        var authorization = URLComponents(url: paisaAPIBaseURL.appending(path: "/api/mobile/authorize"), resolvingAgainstBaseURL: false)!
        authorization.queryItems = [
            URLQueryItem(name: "callback", value: "paisa://sync-auth"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "deviceName", value: UIDevice.current.name)
        ]
        let returnTo = authorization.url!.path + "?" + (authorization.percentEncodedQuery ?? "")
        var signIn = URLComponents(url: paisaAPIBaseURL.appending(path: "/signin-with-chatgpt"), resolvingAgainstBaseURL: false)!
        signIn.queryItems = [URLQueryItem(name: "return_to", value: returnTo)]
        guard await UIApplication.shared.open(signIn.url!) else {
            UserDefaults.standard.removeObject(forKey: pendingStateKey)
            UserDefaults.standard.removeObject(forKey: pendingStateDateKey)
            status = "Safari could not open the secure sign-in page"
            return
        }
        status = "Complete sign-in in Safari"
    }

    func completePairing(callback: URL, context: ModelContext) async {
        guard !isWorking else { return }
        isWorking = true; status = "Finishing secure connection…"
        defer { isWorking = false }
        do {
            guard let expectedState = UserDefaults.standard.string(forKey: pendingStateKey),
                  Date().timeIntervalSince1970 - UserDefaults.standard.double(forKey: pendingStateDateKey) < 600,
                  let components = URLComponents(url: callback, resolvingAgainstBaseURL: false),
                  components.queryItems?.first(where: { $0.name == "state" })?.value == expectedState,
                  let accessToken = components.queryItems?.first(where: { $0.name == "access_token" })?.value,
                  let sitesToken = components.queryItems?.first(where: { $0.name == "sites_token" })?.value else {
                throw SyncFailure.message("The secure sign-in response was invalid or expired")
            }
            try Self.saveKeychain(accessToken, service: tokenService, account: tokenAccount)
            try Self.saveKeychain(sitesToken, service: tokenService, account: sitesTokenAccount)
            UserDefaults.standard.removeObject(forKey: pendingStateKey)
            UserDefaults.standard.removeObject(forKey: pendingStateDateKey)
            connected = true; status = "Connected — syncing…"
            try await sync(context: context)
        } catch { status = error.localizedDescription }
    }

    func syncIfConnected(context: ModelContext) async {
        guard connected, !isWorking else { return }
        isWorking = true; syncCancellationRequested = false; defer { isWorking = false; syncCancellationRequested = false }
        do { try await sync(context: context) } catch { status = error.localizedDescription }
    }

    func stopSync() {
        guard isWorking, syncTotal > 0 else { return }
        syncCancellationRequested = true
        status = "Stopping sync after the current batch…"
    }

    func deleteLocalTransactions(context: ModelContext) throws -> Int {
        let items = try context.fetch(FetchDescriptor<PaisaTransaction>())
        items.forEach(context.delete); try context.save()
        status = connected ? "Local data cleared — cloud data is unchanged" : "All data removed from this iPhone"
        return items.count
    }

    func deleteCloudTransactions(context: ModelContext) async throws -> Int {
        guard connected else { throw SyncFailure.message("Connect this iPhone before deleting cloud data") }
        syncTotal = 0; syncCompleted = 0; isWorking = true; defer { isWorking = false }
        let response: ResetResponse = try await request("/api/mobile/transactions", method: "DELETE", body: Optional<String>.none, authenticated: true)
        _ = try deleteLocalTransactions(context: context)
        status = "Deleted \(response.deleted) cloud transaction\(response.deleted == 1 ? "" : "s")"
        return response.deleted
    }

    func importSharedReceipts(context: ModelContext) {
        do {
            let receipts = try SharedInbox.pending()
            guard !receipts.isEmpty else { return }
            let existing = try context.fetch(FetchDescriptor<PaisaTransaction>())
            let existingIDs = Set(existing.map(\.id))
            var importedIDs: [UUID] = []

            for receipt in receipts {
                if !existingIDs.contains(receipt.id) {
                    context.insert(PaisaTransaction(
                        id: receipt.id,
                        merchant: receipt.merchant,
                        amount: receipt.amount,
                        occurredAt: receipt.occurredAt,
                        category: receipt.category,
                        note: receipt.note,
                        reviewStatus: "unresolved",
                        source: "ios_share",
                        updatedAt: receipt.createdAt
                    ))
                }
                importedIDs.append(receipt.id)
            }
            try context.save()
            for id in importedIDs { try SharedInbox.remove(id: id) }
            let count = receipts.count
            status = "Added \(count) shared \(count == 1 ? "payment" : "payments") to your inbox"
        } catch {
            status = "A shared payment could not be imported: \(error.localizedDescription)"
        }
    }

    func registerPushToken(_ token: String) async {
        guard connected, token.range(of: #"^[0-9a-f]{64,200}$"#, options: [.regularExpression, .caseInsensitive]) != nil else { return }
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        do {
            let _: [String: Bool] = try await request("/api/mobile/push-token", method: "POST", body: ["token": token.lowercased(), "environment": environment], authenticated: true)
        } catch {
            status = "Sync works, but notifications could not register: \(error.localizedDescription)"
        }
    }

    func unregisterPushToken(_ token: String?) async {
        guard connected else { return }
        do {
            let body = token.map { ["token": $0.lowercased()] }
            let _: [String: Bool] = try await request("/api/mobile/push-token", method: "DELETE", body: body, authenticated: true)
        } catch { }
    }

    func disconnect() async {
        guard connected else { return }
        syncTotal = 0; syncCompleted = 0; isWorking = true; defer { isWorking = false }
        await unregisterPushToken(NotificationManager.shared.deviceToken)
        do { let _: [String: Bool] = try await request("/api/mobile/session", method: "DELETE", body: Optional<String>.none, authenticated: true) } catch { }
        Self.deleteKeychain(service: tokenService, account: tokenAccount)
        Self.deleteKeychain(service: tokenService, account: sitesTokenAccount)
        connected = false; lastSynced = nil; status = "Disconnected — data remains on this iPhone"
    }

    private func sync(context: ModelContext) async throws {
        let local = try context.fetch(FetchDescriptor<PaisaTransaction>())
        let payload = local.map { item in
            SyncTransaction(id: item.id.uuidString.lowercased(), merchant: item.merchant, amount: item.amount, occurredAt: Self.format(item.occurredAt), timeVerified: item.timeVerified, category: item.category, context: item.note, reviewStatus: item.reviewStatus, source: item.source, accountTag: item.accountTag, updatedAt: Self.format(item.updatedAt), isDeleted: item.isDeleted)
        }
        syncCompleted = 0; syncTotal = payload.count
        let chunks = payload.isEmpty ? [[]] : stride(from: 0, to: payload.count, by: 200).map { Array(payload[$0..<min($0 + 200, payload.count)]) }
        var response: SyncResponse?
        var aliases: [String: String] = [:]
        for chunk in chunks {
            if syncCancellationRequested { status = "Sync stopped — \(syncCompleted) synced, \(max(0, syncTotal - syncCompleted)) left"; return }
            status = syncTotal > 0 ? "Syncing \(syncCompleted) of \(syncTotal)…" : "Checking the cloud inbox…"
            let result: SyncResponse = try await request("/api/mobile/sync", method: "POST", body: ["transactions": chunk], authenticated: true)
            response = result; result.aliases.forEach { aliases[$0.key] = $0.value }
            syncCompleted = min(syncTotal, syncCompleted + chunk.count)
        }
        guard let response else { return }
        var byID = Dictionary(uniqueKeysWithValues: local.map { ($0.id.uuidString.lowercased(), $0) })

        for (localID, _) in aliases {
            if let item = byID.removeValue(forKey: localID.lowercased()) { context.delete(item) }
        }
        for remote in response.transactions {
            guard let id = UUID(uuidString: remote.id), let occurredAt = Self.parse(remote.occurredAt), let updatedAt = Self.parse(remote.updatedAt) else { continue }
            if let item = byID[remote.id.lowercased()] {
                guard updatedAt >= item.updatedAt else { continue }
                item.merchant = remote.merchant; item.amount = remote.amount; item.occurredAt = occurredAt; item.timeVerified = remote.timeVerified ?? false; item.category = remote.category
                item.note = remote.context; item.reviewStatus = remote.reviewStatus; item.source = remote.source; item.accountTag = remote.accountTag ?? ""; item.updatedAt = updatedAt; item.isDeleted = false
            } else {
                context.insert(PaisaTransaction(id: id, merchant: remote.merchant, amount: remote.amount, occurredAt: occurredAt, timeVerified: remote.timeVerified ?? false, category: remote.category, note: remote.context, reviewStatus: remote.reviewStatus, source: remote.source, accountTag: remote.accountTag ?? "", updatedAt: updatedAt))
            }
        }
        for tombstone in response.tombstones {
            guard let deletedAt = Self.parse(tombstone.deletedAt), let item = byID[tombstone.id.lowercased()], deletedAt >= item.updatedAt else { continue }
            item.isDeleted = true; item.updatedAt = deletedAt
        }
        try context.save()
        if let components = response.preferences?.reviewTime.split(separator: ":"), components.count == 2,
           let hour = Int(components[0]), let minute = Int(components[1]), (0...23).contains(hour), (0...59).contains(minute) {
            reviewHour = hour; reviewMinute = minute
        }
        lastSynced = Date()
        let visibleCount = response.transactions.count
        if syncTotal == 0 { syncTotal = visibleCount; syncCompleted = visibleCount }
        status = "Synced \(visibleCount) \(visibleCount == 1 ? "transaction" : "transactions") just now"
    }

    private func request<Response: Decodable, Body: Encodable>(_ path: String, method: String, body: Body?, authenticated: Bool) async throws -> Response {
        var request = URLRequest(url: paisaAPIBaseURL.appending(path: path)); request.httpMethod = method; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body { request.httpBody = try JSONEncoder().encode(body) }
        if authenticated {
            guard let token = Self.readKeychain(service: tokenService, account: tokenAccount) else { connected = false; throw SyncFailure.message("Connect this iPhone before syncing") }
            guard let sitesToken = Self.readKeychain(service: tokenService, account: sitesTokenAccount) else { connected = false; throw SyncFailure.message("Reconnect this iPhone to refresh secure access") }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("Bearer \(sitesToken)", forHTTPHeaderField: "OAI-Sites-Authorization")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else {
            let statusCode = (response as? HTTPURLResponse)?.statusCode
            let apiMessage = try? JSONDecoder().decode(APIError.self, from: data).error
            let message: String
            if statusCode == 401, apiMessage == nil {
                message = "Secure site access expired. Connect with ChatGPT again."
            } else {
                message = apiMessage ?? "Paisa Inbox could not sync right now"
            }
            if statusCode == 401 {
                connected = false
                Self.deleteKeychain(service: tokenService, account: tokenAccount)
                Self.deleteKeychain(service: tokenService, account: sitesTokenAccount)
            }
            throw SyncFailure.message(message)
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    private static let formatter: ISO8601DateFormatter = { let value = ISO8601DateFormatter(); value.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return value }()
    private static let fallbackFormatter = ISO8601DateFormatter()
    private static func format(_ date: Date) -> String { formatter.string(from: date) }
    private static func parse(_ value: String) -> Date? { formatter.date(from: value) ?? fallbackFormatter.date(from: value) }

    private static func saveKeychain(_ token: String, service: String, account: String) throws {
        deleteKeychain(service: service, account: account)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecValueData as String: Data(token.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { throw SyncFailure.message("The secure token could not be saved") }
    }

    private static func readKeychain(service: String, account: String) -> String? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var value: CFTypeRef?; guard SecItemCopyMatching(query as CFDictionary, &value) == errSecSuccess, let data = value as? Data else { return nil }; return String(data: data, encoding: .utf8)
    }

    private static func deleteKeychain(service: String, account: String) {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] as CFDictionary)
    }
}

private enum SyncFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let value) = self { return value }; return "Sync failed" }
}
