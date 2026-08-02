import Foundation
import AuthenticationServices
import Security
import SwiftData
import UIKit

private let paisaAPIBaseURL = URL(string: "https://paisa-daily-inbox.shashankmahajan.chatgpt.site")!

private struct SyncTransaction: Codable {
    let id: String
    let merchant: String
    let amount: Double
    let occurredAt: String
    let category: String
    let context: String
    let reviewStatus: String
    let source: String
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
}

private struct APIError: Decodable { let error: String }

@MainActor
final class SyncManager: ObservableObject {
    @Published private(set) var connected: Bool
    @Published private(set) var isWorking = false
    @Published private(set) var status = "Stored only on this iPhone"
    @Published private(set) var lastSynced: Date?

    private let tokenService = "com.shashankmahajan.paisa.sync"
    private let tokenAccount = "mobile-access-token"
    private let sitesTokenAccount = "sites-dispatch-token"
    private var authenticationSession: ASWebAuthenticationSession?

    init() { connected = Self.readKeychain(service: tokenService, account: tokenAccount) != nil }

    func beginPairing(context: ModelContext) async {
        guard !isWorking else { return }
        isWorking = true; status = "Waiting for secure sign-in…"
        defer { isWorking = false }
        do {
            let state = UUID().uuidString
            var authorization = URLComponents(url: paisaAPIBaseURL.appending(path: "/api/mobile/authorize"), resolvingAgainstBaseURL: false)!
            authorization.queryItems = [
                URLQueryItem(name: "callback", value: "paisa://sync-auth"),
                URLQueryItem(name: "state", value: state),
                URLQueryItem(name: "deviceName", value: UIDevice.current.name)
            ]
            var signIn = URLComponents(url: paisaAPIBaseURL.appending(path: "/signin-with-chatgpt"), resolvingAgainstBaseURL: false)!
            signIn.queryItems = [URLQueryItem(name: "return_to", value: authorization.url!.relativeString)]
            let callback = try await authenticate(at: signIn.url!)
            guard let components = URLComponents(url: callback, resolvingAgainstBaseURL: false),
                  components.queryItems?.first(where: { $0.name == "state" })?.value == state,
                  let accessToken = components.queryItems?.first(where: { $0.name == "access_token" })?.value,
                  let sitesToken = components.queryItems?.first(where: { $0.name == "sites_token" })?.value else {
                throw SyncFailure.message("The secure sign-in response was invalid")
            }
            try Self.saveKeychain(accessToken, service: tokenService, account: tokenAccount)
            try Self.saveKeychain(sitesToken, service: tokenService, account: sitesTokenAccount)
            connected = true; status = "Connected — syncing…"
            try await sync(context: context)
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            status = "Connection cancelled"
        } catch { status = error.localizedDescription }
    }

    func syncIfConnected(context: ModelContext) async {
        guard connected, !isWorking else { return }
        isWorking = true; defer { isWorking = false }
        do { try await sync(context: context) } catch { status = error.localizedDescription }
    }

    func disconnect() async {
        guard connected else { return }
        isWorking = true; defer { isWorking = false }
        do { let _: [String: Bool] = try await request("/api/mobile/session", method: "DELETE", body: Optional<String>.none, authenticated: true) } catch { }
        Self.deleteKeychain(service: tokenService, account: tokenAccount)
        Self.deleteKeychain(service: tokenService, account: sitesTokenAccount)
        connected = false; lastSynced = nil; status = "Disconnected — data remains on this iPhone"
    }

    private func sync(context: ModelContext) async throws {
        let local = try context.fetch(FetchDescriptor<PaisaTransaction>())
        let payload = local.map { item in
            SyncTransaction(id: item.id.uuidString.lowercased(), merchant: item.merchant, amount: item.amount, occurredAt: Self.format(item.occurredAt), category: item.category, context: item.note, reviewStatus: item.reviewStatus, source: item.source, updatedAt: Self.format(item.updatedAt), isDeleted: item.isDeleted)
        }
        let response: SyncResponse = try await request("/api/mobile/sync", method: "POST", body: ["transactions": payload], authenticated: true)
        var byID = Dictionary(uniqueKeysWithValues: local.map { ($0.id.uuidString.lowercased(), $0) })

        for (localID, _) in response.aliases {
            if let item = byID.removeValue(forKey: localID.lowercased()) { context.delete(item) }
        }
        for remote in response.transactions {
            guard let id = UUID(uuidString: remote.id), let occurredAt = Self.parse(remote.occurredAt), let updatedAt = Self.parse(remote.updatedAt) else { continue }
            if let item = byID[remote.id.lowercased()] {
                guard updatedAt >= item.updatedAt else { continue }
                item.merchant = remote.merchant; item.amount = remote.amount; item.occurredAt = occurredAt; item.category = remote.category
                item.note = remote.context; item.reviewStatus = remote.reviewStatus; item.source = remote.source; item.updatedAt = updatedAt; item.isDeleted = false
            } else {
                context.insert(PaisaTransaction(id: id, merchant: remote.merchant, amount: remote.amount, occurredAt: occurredAt, category: remote.category, note: remote.context, reviewStatus: remote.reviewStatus, source: remote.source, updatedAt: updatedAt))
            }
        }
        for tombstone in response.tombstones {
            guard let deletedAt = Self.parse(tombstone.deletedAt), let item = byID[tombstone.id.lowercased()], deletedAt >= item.updatedAt else { continue }
            item.isDeleted = true; item.updatedAt = deletedAt
        }
        try context.save(); lastSynced = Date(); status = "Synced just now"
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
            let message = (try? JSONDecoder().decode(APIError.self, from: data).error) ?? "Paisa could not sync right now"
            if (response as? HTTPURLResponse)?.statusCode == 401 {
                connected = false
                Self.deleteKeychain(service: tokenService, account: tokenAccount)
                Self.deleteKeychain(service: tokenService, account: sitesTokenAccount)
            }
            throw SyncFailure.message(message)
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    private func authenticate(at url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "paisa") { [weak self] callback, error in
                self?.authenticationSession = nil
                if let error { continuation.resume(throwing: error) }
                else if let callback { continuation.resume(returning: callback) }
                else { continuation.resume(throwing: SyncFailure.message("Secure sign-in did not return to Paisa")) }
            }
            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = WebAuthenticationPresenter.shared
            authenticationSession = session
            guard session.start() else {
                authenticationSession = nil
                continuation.resume(throwing: SyncFailure.message("Secure sign-in could not be opened"))
                return
            }
        }
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

private final class WebAuthenticationPresenter: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = WebAuthenticationPresenter()
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
}

private enum SyncFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let value) = self { return value }; return "Sync failed" }
}
