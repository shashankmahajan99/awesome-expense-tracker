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
    @Environment(\.modelContext) private var context
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var sync: SyncManager
    var body: some View {
        TabView {
            NavigationStack { DashboardView() }
                .tabItem { Label("Today", systemImage: "tray.full") }
            NavigationStack { TransactionsView() }
                .tabItem { Label("Transactions", systemImage: "arrow.up.arrow.down") }
            NavigationStack { InsightsView() }
                .tabItem { Label("Insights", systemImage: "chart.bar") }
            NavigationStack { SettingsView() }
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .tint(Color(red: 0.12, green: 0.31, blue: 0.27))
        .task { await sync.syncIfConnected(context: context) }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await sync.syncIfConnected(context: context) } } }
    }
}
