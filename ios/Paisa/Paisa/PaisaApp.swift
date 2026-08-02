import SwiftUI
import SwiftData

@main
struct PaisaApp: App {
    var body: some Scene {
        WindowGroup { RootView() }
            .modelContainer(for: PaisaTransaction.self)
    }
}

struct RootView: View {
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
    }
}
