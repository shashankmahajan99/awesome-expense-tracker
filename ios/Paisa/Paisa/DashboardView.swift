import SwiftUI
import SwiftData

struct DashboardView: View {
    @EnvironmentObject private var sync: SyncManager
    @Query(filter: #Predicate<PaisaTransaction> { !$0.isDeleted }, sort: \PaisaTransaction.occurredAt, order: .reverse) private var transactions: [PaisaTransaction]
    @State private var showReview = false
    @State private var showImport = false
    @State private var dateWindow: PaisaDateWindow = .all
    @State private var customFrom = Calendar.current.date(byAdding: .month, value: -1, to: .now) ?? .now
    @State private var customTo = Date.now

    // Deferred payments are intentionally understood for today, matching the
    // web inbox. They return only when the server schedules a later review.
    private var visible: [PaisaTransaction] { transactions.filter { dateWindow.contains($0.occurredAt, customFrom: customFrom, customTo: customTo) } }
    private var unresolved: [PaisaTransaction] { visible.filter { $0.reviewStatus == "unresolved" } }
    private var today: [PaisaTransaction] { visible.filter { Calendar.current.isDate($0.occurredAt, inSameDayAs: .now) } }
    private var total: Double { visible.reduce(0) { $0 + $1.amount } }
    private var todayTotal: Double { today.reduce(0) { $0 + $1.amount } }
    private var largest: PaisaTransaction? { visible.max { $0.amount < $1.amount } }
    private var understood: Int { visible.isEmpty ? 100 : Int(Double(visible.count - unresolved.count) / Double(visible.count) * 100) }
    private var unresolvedLabel: String { unresolved.count == 1 ? "1 payment" : "\(unresolved.count) payments" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                freshness
                PaisaDateWindowPicker(selection: $dateWindow, customFrom: $customFrom, customTo: $customTo, title: "Dashboard activity")
                hero
                metrics
                inbox
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 30)
        }
        .background(PaisaTheme.canvas.ignoresSafeArea())
        .toolbarBackground(PaisaTheme.canvas, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .navigationTitle("Paisa Inbox")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Text("P").font(.headline.bold()).foregroundStyle(PaisaTheme.forest)
                    .frame(width: 32, height: 32).background(PaisaTheme.gold, in: Circle())
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showImport = true } label: { Label("Import", systemImage: "plus") }
                    .fontWeight(.semibold)
            }
        }
        .sheet(isPresented: $showReview) { NavigationStack { ReviewView(transactions: unresolved) } }
        .sheet(isPresented: $showImport) { StatementImportView() }
        .onReceive(NotificationCenter.default.publisher(for: .paisaOpenReview)) { _ in if !unresolved.isEmpty { showReview = true } }
    }

    private var freshness: some View {
        HStack(alignment: .top, spacing: 11) {
            Image(systemName: sync.bankConnections.contains(where: { $0.status == "ACTIVE" }) ? "building.columns.fill" : (sync.connected ? "checkmark.icloud" : "iphone"))
                .foregroundStyle(PaisaTheme.forest)
            VStack(alignment: .leading, spacing: 3) {
                Text(sync.bankConnections.contains(where: { $0.status == "ACTIVE" }) ? "Automatic bank updates are on" : (sync.connected ? "Cloud sync is on" : "Stored on this iPhone"))
                    .font(.subheadline.weight(.semibold)).foregroundStyle(PaisaTheme.ink)
                Text(sync.bankConnections.contains(where: { $0.status == "ACTIVE" }) ? "Bank data arrives periodically. Recent payments may still be pending." : sync.status)
                    .font(.caption).foregroundStyle(PaisaTheme.muted)
            }
            Spacer()
        }
        .padding(13).background(PaisaTheme.surface, in: RoundedRectangle(cornerRadius: 16)).overlay(RoundedRectangle(cornerRadius: 16).stroke(PaisaTheme.line))
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 7) {
            PaisaEyebrow(text: "Your daily financial inbox")
            Text(unresolved.isEmpty ? "Everything makes sense." : "A few things need your attention.")
                .font(.system(size: 34, weight: .semibold, design: .rounded))
                .foregroundStyle(PaisaTheme.ink)
            Text(unresolved.isEmpty ? "Your inbox is clear. Add or import transactions whenever you’re ready." : "\(unresolvedLabel.capitalized) still need context.")
                .font(.subheadline).foregroundStyle(PaisaTheme.muted)
        }
        .padding(.top, 8)
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                PaisaEyebrow(text: "Total tracked").foregroundStyle(.white.opacity(0.66))
                Spacer()
                Text("\(visible.count) payments").font(.caption.weight(.semibold)).foregroundStyle(.white.opacity(0.72))
            }
            Text(PaisaFormat.amount(total)).font(.system(size: 38, weight: .bold, design: .rounded)).foregroundStyle(.white)
            HStack(spacing: 10) {
                heroChip("\(understood)%", "Understood", PaisaTheme.gold)
                heroChip(largest.map { PaisaFormat.amount($0.amount) } ?? "₹0", "Largest", PaisaTheme.peach)
            }
            Button { showReview = true } label: {
                HStack { Image(systemName: unresolved.isEmpty ? "checkmark" : "sparkles"); Text(unresolved.isEmpty ? "Inbox clear" : "Review today"); Spacer(); if !unresolved.isEmpty { Image(systemName: "arrow.right") } }
                    .fontWeight(.bold).padding(.horizontal, 16).frame(height: 50)
                    .background(unresolved.isEmpty ? Color.white.opacity(0.13) : PaisaTheme.gold, in: RoundedRectangle(cornerRadius: 14))
                    .foregroundStyle(unresolved.isEmpty ? .white : PaisaTheme.forestDeep)
            }
            .disabled(unresolved.isEmpty)
        }
        .padding(20)
        .background(PaisaTheme.forestDeep, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
    }

    private func heroChip(_ value: String, _ label: String, _ accent: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(value).font(.headline.bold()).foregroundStyle(.white)
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(1).foregroundStyle(.white.opacity(0.62))
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(13)
        .background(accent.opacity(0.18), in: RoundedRectangle(cornerRadius: 15))
        .overlay(RoundedRectangle(cornerRadius: 15).stroke(accent.opacity(0.45)))
    }

    private var metrics: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
            metric("Today", PaisaFormat.amount(todayTotal), "arrow.up.right")
            metric("Understood", "\(understood)%", "checkmark.circle")
            metric("Largest", largest.map { PaisaFormat.amount($0.amount) } ?? "₹0", "diamond")
            metric("Needs context", PaisaFormat.amount(unresolved.reduce(0) { $0 + $1.amount }), "clock")
        }
    }

    private func metric(_ label: String, _ value: String, _ icon: String) -> some View {
        PaisaCard {
            Image(systemName: icon).foregroundStyle(PaisaTheme.forest).padding(8).background(PaisaTheme.forest.opacity(0.08), in: Circle())
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(1.1).foregroundStyle(PaisaTheme.muted).padding(.top, 8)
            Text(value).font(.title3.bold()).foregroundStyle(PaisaTheme.ink).padding(.top, 1)
        }
    }

    private var inbox: some View {
        PaisaCard {
            HStack {
                VStack(alignment: .leading, spacing: 4) { PaisaEyebrow(text: "Needs your input"); Text("Daily inbox").font(.title3.bold()).foregroundStyle(PaisaTheme.ink) }
                Spacer()
                if !unresolved.isEmpty { Button("Review all") { showReview = true }.font(.subheadline.bold()) }
            }
            if unresolved.isEmpty {
                HStack(spacing: 12) {
                    Image(systemName: "checkmark").font(.headline.bold()).foregroundStyle(PaisaTheme.forest).frame(width: 42, height: 42).background(PaisaTheme.forest.opacity(0.1), in: Circle())
                    VStack(alignment: .leading, spacing: 3) { Text("All clear for today.").fontWeight(.bold); Text("You’ve explained everything that matters.").font(.caption).foregroundStyle(PaisaTheme.muted) }
                }.padding(.top, 18)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(unresolved.prefix(6).enumerated()), id: \.element.id) { index, item in
                        if index > 0 { Divider() }
                        Button { showReview = true } label: { TransactionRow(item: item) }.buttonStyle(.plain)
                    }
                }.padding(.top, 8)
            }
        }
    }
}

struct SummaryCard: View {
    let title: String; let value: String; let icon: String
    var body: some View { PaisaCard { Image(systemName: icon).foregroundStyle(PaisaTheme.forest); Text(value).font(.title2.bold()).foregroundStyle(PaisaTheme.ink); Text(title.uppercased()).font(.caption2.bold()).tracking(1).foregroundStyle(PaisaTheme.muted) } }
}

struct TransactionRow: View {
    let item: PaisaTransaction
    var body: some View {
        HStack(spacing: 12) {
            Text(String(item.merchant.prefix(2)).uppercased()).font(.caption.bold()).foregroundStyle(PaisaTheme.forest)
                .frame(width: 42, height: 42).background(PaisaTheme.forest.opacity(0.09), in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 4) {
                Text(item.merchant).font(.body.weight(.semibold)).foregroundStyle(PaisaTheme.ink)
                Text([item.category, item.accountTag, PaisaFormat.transactionDate(item.occurredAt, timeVerified: item.timeVerified)].filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).foregroundStyle(PaisaTheme.muted)
            }
            Spacer()
            Text(PaisaFormat.amount(item.amount)).fontWeight(.bold).foregroundStyle(PaisaTheme.ink)
        }.padding(.vertical, 10)
    }
}
