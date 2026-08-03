import SwiftUI
import SwiftData

@main
struct PaisaApp: App {
    @UIApplicationDelegateAdaptor(PaisaAppDelegate.self) private var appDelegate
    @StateObject private var sync = SyncManager()
    @StateObject private var notifications = NotificationManager.shared
    var body: some Scene {
        WindowGroup { RootView().environmentObject(sync).environmentObject(notifications) }
            .modelContainer(for: PaisaTransaction.self)
    }
}

struct RootView: View {
    private enum Tab: Hashable { case today, transactions, insights, settings }
    @Environment(\.modelContext) private var context
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var sync: SyncManager
    @EnvironmentObject private var notifications: NotificationManager
    @State private var selectedTab: Tab = .today
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
        .preferredColorScheme(.light)
        .task { await importSharesAndSync() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await importSharesAndSync() } } }
        .onOpenURL { url in
            guard url.scheme == "paisa" else { return }
            if url.host == "settings" { selectedTab = .settings }
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
        await sync.syncIfConnected(context: context)
        if let transactions = try? context.fetch(FetchDescriptor<PaisaTransaction>()) {
            let unresolved = transactions.filter { !$0.isDeleted && $0.reviewStatus == "unresolved" }
            await notifications.scheduleDailyInbox(unresolvedCount: unresolved.count, unresolvedAmount: unresolved.reduce(0) { $0 + $1.amount }, reviewHour: sync.reviewHour, reviewMinute: sync.reviewMinute)
        }
        if notifications.isEnabledForPaisa, let token = notifications.deviceToken { await sync.registerPushToken(token) }
    }
}
