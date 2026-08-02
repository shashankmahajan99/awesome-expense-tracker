import SwiftUI
import SwiftData

@main
struct PaisaApp: App {
    @StateObject private var sync = SyncManager()
    var body: some Scene {
        WindowGroup { RootView().environmentObject(sync) }
            .modelContainer(for: PaisaTransaction.self)
    }
}

struct RootView: View {
    private enum Tab: Hashable { case today, transactions, insights, settings }
    @Environment(\.modelContext) private var context
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var sync: SyncManager
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
    }

    @MainActor
    private func importSharesAndSync() async {
        sync.importSharedReceipts(context: context)
        await sync.syncIfConnected(context: context)
    }
}
