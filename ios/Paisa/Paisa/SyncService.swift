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
    let duplicatesMerged: Int?
    let accounts: [SyncPaymentAccount]?
    let preferences: MobileSyncPreferences?
}

private struct SyncPaymentAccount: Codable {
    let id: String; let name: String; let kind: String; let institution: String; let lastFour: String; let aliases: [String]; let updatedAt: String?
}
private struct MobileSyncPayload: Encodable { let transactions: [SyncTransaction]; let accounts: [SyncPaymentAccount] }

private struct MobileSyncPreferences: Decodable { let reviewTime: String }

private struct APIError: Decodable { let error: String }
private struct ResetResponse: Decodable { let deleted: Int }
private struct DeleteAccountResponse: Decodable { let deleted: Bool }

struct BankConnection: Decodable, Identifiable {
    struct LinkedAccount: Decodable, Identifiable {
        let maskedAccNumber: String
        let accType: String
        let fipId: String
        var id: String { "\(fipId):\(maskedAccNumber)" }
    }
    let id: String
    let provider: String
    let status: String
    let mobileLastFour: String
    let consentUrl: String
    let purpose: String
    let dataRequested: [String]
    let dataRangeFrom: String?
    let dataRangeTo: String?
    let expiresAt: String?
    let frequency: String
    let dataLife: String
    let accounts: [LinkedAccount]
    let lastSyncedAt: String?
    let lastError: String

    var isCurrent: Bool { ["ACTIVE", "PENDING", "INITIATED", "PAUSED"].contains(status) }
}

private struct BankConnectionsResponse: Decodable { let configured: Bool; let connections: [BankConnection] }
private struct BankConnectionMutationResponse: Decodable { let connection: BankConnection; let consentUrl: String? }
private struct CreateBankConsentPayload: Encodable { let mobile: String }

private struct MoneyPlanWire: Decodable {
    let month: String
    let incomePaise: Int64
    let plannedSavingsPaise: Int64
    let fixedCostsPaise: Int64
    let availablePaise: Int64
    let spentPaise: Int64
    let remainingPaise: Int64
    let intention: String
    let reflection: String
}
private struct MoneyPlanResponse: Decodable { let plan: MoneyPlanWire }
private struct MoneyPlanPayload: Encodable {
    let month: String
    let income: Double
    let plannedSavings: Double
    let fixedCosts: Double
    let intention: String
    let reflection: String
}

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
    @Published private(set) var bankConnections: [BankConnection] = []
    @Published private(set) var bankConnectionsConfigured = false
    @Published private(set) var bankStatus = "Sign in to connect a bank"
    @Published private(set) var bankLoading = false

    private let tokenService = "com.shashankmahajan.paisa.sync"
    private let tokenAccount = "mobile-access-token"
    private let sitesTokenAccount = "sites-dispatch-token"
    private let pendingStateKey = "paisa.pending-sync-state"
    private let pendingStateDateKey = "paisa.pending-sync-state-created-at"
    private var networkSession = URLSession(configuration: .default)

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
        do { try await sync(context: context) }
        catch where syncCancellationRequested || (error as? URLError)?.code == .cancelled { status = "Sync stopped — \(syncCompleted) completed, \(max(0, syncTotal - syncCompleted)) left" }
        catch { status = error.localizedDescription }
    }

    func stopSync() {
        guard isWorking else { return }
        syncCancellationRequested = true
        status = "Stopping sync…"
        networkSession.invalidateAndCancel()
        networkSession = URLSession(configuration: .default)
    }

    private func clearLocalTransactions(context: ModelContext) throws -> Int {
        let items = try context.fetch(FetchDescriptor<PaisaTransaction>())
        items.forEach(context.delete); try context.save()
        return items.count
    }

    func deleteCloudTransactions(context: ModelContext) async throws -> Int {
        guard connected else { throw SyncFailure.message("Connect this iPhone before deleting cloud data") }
        if isWorking {
            stopSync()
            while isWorking { try await Task.sleep(for: .milliseconds(40)) }
        }
        syncCancellationRequested = false; syncTotal = 1; syncCompleted = 0; isWorking = true; status = "Deleting transactions everywhere…"; defer { isWorking = false; syncCancellationRequested = false }
        let response: ResetResponse = try await request("/api/mobile/transactions", method: "DELETE", body: Optional<String>.none, authenticated: true)
        _ = try clearLocalTransactions(context: context)
        syncCompleted = 1
        status = "Deleted \(response.deleted) cloud transaction\(response.deleted == 1 ? "" : "s")"
        return response.deleted
    }

    func deleteAccount(context: ModelContext) async throws {
        guard connected else { throw SyncFailure.message("Connect this iPhone before deleting your account") }
        if isWorking { stopSync(); while isWorking { try await Task.sleep(for: .milliseconds(40)) } }
        isWorking = true; status = "Revoking bank consent and deleting your account…"
        defer { isWorking = false }
        let _: DeleteAccountResponse = try await request("/api/mobile/account", method: "DELETE", body: Optional<String>.none, authenticated: true)
        try context.fetch(FetchDescriptor<PaisaTransaction>()).forEach(context.delete)
        try context.fetch(FetchDescriptor<PaymentAccount>()).forEach(context.delete)
        try context.fetch(FetchDescriptor<MonthlyMoneyPlan>()).forEach(context.delete)
        try context.save()
        Self.deleteKeychain(service: tokenService, account: tokenAccount)
        Self.deleteKeychain(service: tokenService, account: sitesTokenAccount)
        bankConnections = []; connected = false; lastSynced = nil
        status = "Account deleted — this iPhone is now local only"
    }

    func loadBankConnections() async {
        guard connected else { bankStatus = "Sign in to connect a bank"; return }
        bankLoading = true; defer { bankLoading = false }
        do {
            let response: BankConnectionsResponse = try await request("/api/mobile/bank-connections", method: "GET", body: Optional<String>.none, authenticated: true)
            bankConnectionsConfigured = response.configured; bankConnections = response.connections
            if !response.configured { bankStatus = "Setu is being prepared for this Paisa environment" }
            else if let active = response.connections.first(where: { $0.status == "ACTIVE" }) { bankStatus = active.lastSyncedAt == nil ? "Connected — waiting for the first bank update" : "Connected — bank data updates periodically" }
            else if response.connections.contains(where: { $0.isCurrent }) { bankStatus = "Consent needs your attention" }
            else { bankStatus = "No bank connected" }
        } catch { bankStatus = error.localizedDescription }
    }

    func createBankConsent(mobile: String) async -> URL? {
        guard connected else { bankStatus = "Sign in before connecting a bank"; return nil }
        bankLoading = true; defer { bankLoading = false }
        do {
            let response: BankConnectionMutationResponse = try await request("/api/mobile/bank-connections/setu/consents", method: "POST", body: CreateBankConsentPayload(mobile: mobile), authenticated: true)
            bankConnections.removeAll { $0.id == response.connection.id }; bankConnections.insert(response.connection, at: 0)
            bankStatus = "Complete consent in Setu’s secure flow"
            return URL(string: response.consentUrl ?? response.connection.consentUrl)
        } catch { bankStatus = error.localizedDescription; return nil }
    }

    func refreshBankConnection(_ connection: BankConnection) async {
        guard connected else { return }
        bankLoading = true; defer { bankLoading = false }
        do {
            let response: BankConnectionMutationResponse = try await request("/api/mobile/bank-connections/\(connection.id)/refresh", method: "POST", body: Optional<String>.none, authenticated: true)
            replaceBankConnection(response.connection); bankStatus = response.connection.status == "ACTIVE" ? "Connected — bank data updates periodically" : "Consent status: \(response.connection.status.capitalized)"
        } catch { bankStatus = error.localizedDescription }
    }

    func revokeBankConnection(_ connection: BankConnection) async {
        guard connected else { return }
        bankLoading = true; defer { bankLoading = false }
        do {
            let response: BankConnectionMutationResponse = try await request("/api/mobile/bank-connections/\(connection.id)/revoke", method: "POST", body: Optional<String>.none, authenticated: true)
            replaceBankConnection(response.connection); bankStatus = "Bank consent revoked"
        } catch { bankStatus = error.localizedDescription }
    }

    func loadMoneyPlan(month: String, context: ModelContext) async {
        guard connected else { return }
        do {
            let response: MoneyPlanResponse = try await request("/api/mobile/money-plan?month=\(month)", method: "GET", body: Optional<String>.none, authenticated: true)
            apply(response.plan, context: context)
        } catch { status = "Your local plan is available; cloud refresh failed: \(error.localizedDescription)" }
    }

    func saveMoneyPlan(_ plan: MonthlyMoneyPlan, context: ModelContext) async {
        plan.needsSync = true; plan.updatedAt = .now; try? context.save()
        guard connected else { status = "Plan saved on this iPhone — sign in to sync it"; return }
        do {
            let payload = MoneyPlanPayload(month: plan.month, income: plan.income, plannedSavings: plan.plannedSavings, fixedCosts: plan.fixedCosts, intention: plan.intention, reflection: plan.reflection)
            let response: MoneyPlanResponse = try await request("/api/mobile/money-plan", method: "PUT", body: payload, authenticated: true)
            apply(response.plan, context: context); status = "Monthly plan saved everywhere"
        } catch { status = "Plan saved on this iPhone; cloud sync will retry later" }
    }

    private func replaceBankConnection(_ connection: BankConnection) {
        if let index = bankConnections.firstIndex(where: { $0.id == connection.id }) { bankConnections[index] = connection }
        else { bankConnections.insert(connection, at: 0) }
    }

    private func apply(_ remote: MoneyPlanWire, context: ModelContext) {
        let month = remote.month
        let descriptor = FetchDescriptor<MonthlyMoneyPlan>(predicate: #Predicate { $0.month == month })
        let plan = (try? context.fetch(descriptor).first) ?? MonthlyMoneyPlan(month: month)
        if plan.modelContext == nil { context.insert(plan) }
        plan.income = Double(remote.incomePaise) / 100; plan.plannedSavings = Double(remote.plannedSavingsPaise) / 100
        plan.fixedCosts = Double(remote.fixedCostsPaise) / 100; plan.spent = Double(remote.spentPaise) / 100
        plan.intention = remote.intention; plan.reflection = remote.reflection; plan.needsSync = false; plan.updatedAt = .now
        try? context.save()
    }

    func importSharedReceipts(context: ModelContext) {
        do {
            let receipts = try SharedInbox.pending()
            guard !receipts.isEmpty else { return }
            let existing = try context.fetch(FetchDescriptor<PaisaTransaction>())
            let existingIDs = Set(existing.map(\.id))
            var candidates = existing.filter { !$0.isDeleted }
            var importedIDs: [UUID] = []

            for receipt in receipts {
                if !existingIDs.contains(receipt.id) {
                    if let match = candidates.first(where: { Self.isLikelyDuplicate($0, receipt) }) {
                        if receipt.timeVerified == true && !match.timeVerified { match.occurredAt = receipt.occurredAt; match.timeVerified = true }
                        if match.category.localizedCaseInsensitiveCompare("Uncategorised") == .orderedSame && receipt.category.localizedCaseInsensitiveCompare("Uncategorised") != .orderedSame { match.category = receipt.category }
                        if !receipt.note.isEmpty && !match.note.contains(receipt.note) { match.note = [match.note, receipt.note].filter { !$0.isEmpty }.joined(separator: " · ") }
                        match.source = Set((match.source + ",ios_share").split(separator: ",").map(String.init)).sorted().joined(separator: ",")
                        match.updatedAt = max(match.updatedAt, receipt.createdAt)
                    } else {
                        let transaction = PaisaTransaction(
                        id: receipt.id,
                        merchant: receipt.merchant,
                        amount: receipt.amount,
                        occurredAt: receipt.occurredAt,
                        timeVerified: receipt.timeVerified ?? false,
                        category: receipt.category,
                        note: receipt.note,
                        reviewStatus: "unresolved",
                        source: "ios_share",
                        accountTag: receipt.accountTag ?? "",
                        updatedAt: receipt.createdAt
                        )
                        context.insert(transaction); candidates.append(transaction)
                    }
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

    private static func isLikelyDuplicate(_ item: PaisaTransaction, _ receipt: SharedReceipt) -> Bool {
        guard abs(item.amount - receipt.amount) < 0.005, abs(item.occurredAt.timeIntervalSince(receipt.occurredAt)) <= 86_400 else { return false }
        let leftReference = transactionReference(in: item.note), rightReference = transactionReference(in: receipt.note)
        if !leftReference.isEmpty && !rightReference.isEmpty { return leftReference.caseInsensitiveCompare(rightReference) == .orderedSame }
        let sameDay = Calendar.current.isDate(item.occurredAt, inSameDayAs: receipt.occurredAt)
        let bothTimed = item.timeVerified && receipt.timeVerified == true
        let closeTime = bothTimed && abs(item.occurredAt.timeIntervalSince(receipt.occurredAt)) <= 10 * 60
        let sameAccount = !(receipt.accountTag ?? "").isEmpty && item.accountTag.caseInsensitiveCompare(receipt.accountTag ?? "") == .orderedSame
        let crossSource = !item.source.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.contains("ios_share")
        let similarity = merchantSimilarity(item.merchant, receipt.merchant)
        if closeTime && similarity >= 0.5 { return true }
        if sameAccount && sameDay && !bothTimed && similarity >= 0.85 { return true }
        return crossSource && sameDay && !bothTimed && similarity >= 0.8
    }

    private static func transactionReference(in value: String) -> String {
        let pattern = #"(?i)(?:transaction\s*id|reference|utr|upi\s*ref)[:\s/-]*([A-Z0-9-]{6,40})"#
        guard let regex = try? NSRegularExpression(pattern: pattern), let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)), let range = Range(match.range(at: 1), in: value) else { return "" }
        return String(value[range])
    }

    private static func merchantSimilarity(_ lhs: String, _ rhs: String) -> Double {
        func tokens(_ value: String) -> Set<String> { Set(value.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init).filter { $0.count > 2 && !["upi", "paytm", "payment", "transaction", "debit"].contains($0) }) }
        let left = tokens(lhs), right = tokens(rhs); guard !left.isEmpty, !right.isEmpty else { return 0 }
        return Double(left.intersection(right).count) / Double(left.union(right).count)
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
        let localAccounts = try context.fetch(FetchDescriptor<PaymentAccount>())
        let payload = local.map { item in
            SyncTransaction(id: item.id.uuidString.lowercased(), merchant: item.merchant, amount: item.amount, occurredAt: Self.format(item.occurredAt), timeVerified: item.timeVerified, category: item.category, context: item.note, reviewStatus: item.reviewStatus, source: item.source, accountTag: item.accountTag, updatedAt: Self.format(item.updatedAt), isDeleted: item.isDeleted)
        }
        syncCompleted = 0; syncTotal = max(1, payload.count)
        let chunks = payload.isEmpty ? [[]] : stride(from: 0, to: payload.count, by: 200).map { Array(payload[$0..<min($0 + 200, payload.count)]) }
        var response: SyncResponse?
        var aliases: [String: String] = [:]
        for chunk in chunks {
            try Task.checkCancellation(); if syncCancellationRequested { throw CancellationError() }
            status = payload.isEmpty ? "Checking the cloud inbox…" : "Uploading \(syncCompleted) of \(payload.count)…"
            let accountPayload = localAccounts.map { SyncPaymentAccount(id: $0.id.uuidString.lowercased(), name: $0.name, kind: $0.kind, institution: $0.institution, lastFour: $0.lastFour, aliases: $0.aliases, updatedAt: Self.format($0.updatedAt)) }
            let result: SyncResponse = try await request("/api/mobile/sync", method: "POST", body: MobileSyncPayload(transactions: chunk, accounts: accountPayload), authenticated: true)
            response = result; result.aliases.forEach { aliases[$0.key] = $0.value }
            syncCompleted = min(payload.count, syncCompleted + chunk.count)
        }
        guard let response else { return }
        let uploadCount = payload.count
        syncTotal = max(1, uploadCount + response.transactions.count + response.tombstones.count)
        syncCompleted = uploadCount
        status = "Applying cloud changes…"
        var byID = Dictionary(uniqueKeysWithValues: local.map { ($0.id.uuidString.lowercased(), $0) })

        for (localID, _) in aliases {
            if let item = byID.removeValue(forKey: localID.lowercased()) { context.delete(item) }
        }
        for remote in response.transactions {
            if syncCancellationRequested { throw CancellationError() }
            guard let id = UUID(uuidString: remote.id), let occurredAt = Self.parse(remote.occurredAt), let updatedAt = Self.parse(remote.updatedAt) else { continue }
            if let item = byID[remote.id.lowercased()] {
                guard updatedAt >= item.updatedAt else { continue }
                item.merchant = remote.merchant; item.amount = remote.amount; item.occurredAt = occurredAt; item.timeVerified = remote.timeVerified ?? false; item.category = remote.category
                item.note = remote.context; item.reviewStatus = remote.reviewStatus; item.source = remote.source; item.accountTag = remote.accountTag ?? ""; item.updatedAt = updatedAt; item.isDeleted = false
            } else {
                context.insert(PaisaTransaction(id: id, merchant: remote.merchant, amount: remote.amount, occurredAt: occurredAt, timeVerified: remote.timeVerified ?? false, category: remote.category, note: remote.context, reviewStatus: remote.reviewStatus, source: remote.source, accountTag: remote.accountTag ?? "", updatedAt: updatedAt))
            }
            syncCompleted += 1; status = "Applied \(syncCompleted) of \(syncTotal)…"
        }
        for tombstone in response.tombstones {
            if syncCancellationRequested { throw CancellationError() }
            guard let deletedAt = Self.parse(tombstone.deletedAt), let item = byID[tombstone.id.lowercased()], deletedAt >= item.updatedAt else { continue }
            item.isDeleted = true; item.updatedAt = deletedAt
            syncCompleted += 1; status = "Applied \(syncCompleted) of \(syncTotal)…"
        }
        let accountsByID = Dictionary(uniqueKeysWithValues: localAccounts.map { ($0.id.uuidString.lowercased(), $0) })
        let accountsByName = Dictionary(localAccounts.map { ($0.name.lowercased(), $0) }, uniquingKeysWith: { first, _ in first })
        for remote in response.accounts ?? [] {
            guard let id = UUID(uuidString: remote.id) else { continue }
            if let account = accountsByID[remote.id.lowercased()] ?? accountsByName[remote.name.lowercased()] { account.name = remote.name; account.kind = remote.kind; account.institution = remote.institution; account.lastFour = remote.lastFour; account.aliasesJSON = (try? String(data: JSONEncoder().encode(remote.aliases), encoding: .utf8)) ?? "[]" }
            else { context.insert(PaymentAccount(id: id, name: remote.name, kind: remote.kind, institution: remote.institution, lastFour: remote.lastFour, aliases: remote.aliases)) }
        }
        try context.save()
        let savedAccounts = try context.fetch(FetchDescriptor<PaymentAccount>())
        SharedPaymentAccountDirectory.save(savedAccounts.map { SharedPaymentAccount(id: $0.id, name: $0.name, kind: $0.kind, institution: $0.institution, lastFour: $0.lastFour) })
        let pendingPlans = (try? context.fetch(FetchDescriptor<MonthlyMoneyPlan>()))?.filter(\.needsSync) ?? []
        for plan in pendingPlans {
            let payload = MoneyPlanPayload(month: plan.month, income: plan.income, plannedSavings: plan.plannedSavings, fixedCosts: plan.fixedCosts, intention: plan.intention, reflection: plan.reflection)
            if let response: MoneyPlanResponse = try? await request("/api/mobile/money-plan", method: "PUT", body: payload, authenticated: true) { apply(response.plan, context: context) }
        }
        if let components = response.preferences?.reviewTime.split(separator: ":"), components.count == 2,
           let hour = Int(components[0]), let minute = Int(components[1]), (0...23).contains(hour), (0...59).contains(minute) {
            reviewHour = hour; reviewMinute = minute
        }
        lastSynced = Date()
        let visibleCount = response.transactions.count
        syncCompleted = syncTotal
        let mergedCount = response.duplicatesMerged ?? aliases.count
        let mergedSuffix = mergedCount > 0 ? " · merged \(mergedCount) duplicate\(mergedCount == 1 ? "" : "s")" : ""
        status = "Synced \(visibleCount) \(visibleCount == 1 ? "transaction" : "transactions")\(mergedSuffix) just now"
    }

    private func request<Response: Decodable, Body: Encodable>(_ path: String, method: String, body: Body?, authenticated: Bool) async throws -> Response {
        let pieces = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        var components = URLComponents(url: paisaAPIBaseURL.appending(path: String(pieces[0])), resolvingAgainstBaseURL: false)!
        if pieces.count == 2 { components.percentEncodedQuery = String(pieces[1]) }
        var request = URLRequest(url: components.url!); request.httpMethod = method; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body { request.httpBody = try JSONEncoder().encode(body) }
        if authenticated {
            guard let token = Self.readKeychain(service: tokenService, account: tokenAccount) else { connected = false; throw SyncFailure.message("Connect this iPhone before syncing") }
            guard let sitesToken = Self.readKeychain(service: tokenService, account: sitesTokenAccount) else { connected = false; throw SyncFailure.message("Reconnect this iPhone to refresh secure access") }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("Bearer \(sitesToken)", forHTTPHeaderField: "OAI-Sites-Authorization")
        }
        let (data, response) = try await networkSession.data(for: request)
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
