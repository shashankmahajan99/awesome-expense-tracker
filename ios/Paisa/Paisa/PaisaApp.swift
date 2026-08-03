import SwiftUI
import SwiftData

@main
struct PaisaApp: App {
    @UIApplicationDelegateAdaptor(PaisaAppDelegate.self) private var appDelegate
    @StateObject private var sync = SyncManager()
    @StateObject private var notifications = NotificationManager.shared
    var body: some Scene {
        WindowGroup { RootView().environmentObject(sync).environmentObject(notifications) }
            .modelContainer(for: [PaisaTransaction.self, PaymentAccount.self])
    }
}

struct RootView: View {
    private enum Tab: Hashable { case today, transactions, insights, settings }
    @Environment(\.modelContext) private var context
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var sync: SyncManager
    @EnvironmentObject private var notifications: NotificationManager
    @State private var selectedTab: Tab = .today
    @AppStorage("paisaAppearance") private var appearance = "system"
    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationStack { DashboardView() }
                .tabItem { Label("Today", systemImage: "tray.full") }
                .tag(Tab.today)
            NavigationStack { TransactionsView() }
                .tabItem { Label("Transactions", systemImage: "arrow.up.arrow.down") }
                .tag(Tab.transactions)
            NavigationStack { InsightsView() }
                .tabItem { Label("Insights", systemImage: "chart.bar") }
                .tag(Tab.insights)
            NavigationStack { SettingsView() }
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(Tab.settings)
        }
        .tint(PaisaTheme.forest)
        .toolbarBackground(PaisaTheme.surface, for: .tabBar)
        .preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil)
        .onAppear { SharedAppearance.save(appearance) }
        .onChange(of: appearance) { _, value in SharedAppearance.save(value) }
        .task { await importSharesAndSync() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await importSharesAndSync() } } }
        .onOpenURL { url in
            guard url.scheme == "paisa" else { return }
            if url.host == "settings" { selectedTab = .settings }
            if url.host == "inbox" { selectedTab = .today; Task { await importSharesAndSync() } }
            if url.host == "sync-auth" {
                selectedTab = .settings
                Task { await sync.completePairing(callback: url, context: context) }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .paisaPushTokenChanged)) { notification in
            guard let token = notification.object as? String else { return }
            Task { await sync.registerPushToken(token) }
        }
        .onReceive(NotificationCenter.default.publisher(for: .paisaOpenReview)) { _ in selectedTab = .today }
    }

    @MainActor
    private func importSharesAndSync() async {
        await notifications.configure()
        sync.importSharedReceipts(context: context)
        bootstrapPaymentAccounts()
        await sync.syncIfConnected(context: context)
        if let transactions = try? context.fetch(FetchDescriptor<PaisaTransaction>()) {
            let unresolved = transactions.filter { !$0.isDeleted && $0.reviewStatus == "unresolved" }
            publishCaptureProfile(transactions)
            await notifications.scheduleDailyInbox(unresolvedCount: unresolved.count, unresolvedAmount: unresolved.reduce(0) { $0 + $1.amount }, reviewHour: sync.reviewHour, reviewMinute: sync.reviewMinute)
        }
        if notifications.isEnabledForPaisa, let token = notifications.deviceToken { await sync.registerPushToken(token) }
    }

    private func bootstrapPaymentAccounts() {
        guard let transactions = try? context.fetch(FetchDescriptor<PaisaTransaction>()), let accounts = try? context.fetch(FetchDescriptor<PaymentAccount>()) else { return }
        let names = Set(accounts.map { $0.name.lowercased() })
        for tag in Set(transactions.map(\.accountTag).filter { !$0.isEmpty }) where !names.contains(tag.lowercased()) {
            let lower = tag.lowercased(), kind = lower.contains("card") ? "card" : (lower.contains("paytm") || lower.contains("wallet") ? "wallet" : "bank")
            let institution = ["ICICI", "HDFC", "Axis", "SBI", "Kotak"].first { lower.contains($0.lowercased()) } ?? ""
            context.insert(PaymentAccount(name: tag, kind: kind, institution: institution))
        }
        try? context.save()
        if let saved = try? context.fetch(FetchDescriptor<PaymentAccount>()) { publishPaymentAccounts(saved) }
    }

    private func publishPaymentAccounts(_ accounts: [PaymentAccount]) {
        SharedPaymentAccountDirectory.save(accounts.map { SharedPaymentAccount(id: $0.id, name: $0.name, kind: $0.kind, institution: $0.institution, lastFour: $0.lastFour) })
    }

    private func publishCaptureProfile(_ transactions: [PaisaTransaction]) {
        let recent = transactions.filter { !$0.isDeleted }.sorted { $0.occurredAt > $1.occurredAt }
        var categoryByMerchant: [String: String] = [:]
        for item in recent where categoryByMerchant.count < 200 {
            guard !item.merchant.isEmpty, !item.category.isEmpty, item.category.localizedCaseInsensitiveCompare("Uncategorised") != .orderedSame else { continue }
            let key = SharedCaptureProfile.normalize(item.merchant)
            if !key.isEmpty && categoryByMerchant[key] == nil { categoryByMerchant[key] = item.category }
        }
        let lastAccount = recent.first { !$0.accountTag.isEmpty }?.accountTag
        SharedCaptureProfileDirectory.save(SharedCaptureProfile(lastAccountName: lastAccount, categoryByMerchant: categoryByMerchant))
    }
}
