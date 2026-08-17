import SwiftData
import SwiftUI

struct MoneyPlanView: View {
    @Environment(\.modelContext) private var context
    @EnvironmentObject private var sync: SyncManager
    @Query private var plans: [MonthlyMoneyPlan]
    @Query(filter: #Predicate<PaisaTransaction> { !$0.isDeleted }) private var transactions: [PaisaTransaction]
    @State private var selectedMonth = Date.now
    @State private var income = 0.0
    @State private var savings = 0.0
    @State private var fixedCosts = 0.0
    @State private var intention = ""
    @State private var reflection = ""
    @State private var hydratedMonth = ""

    private var month: String { Self.monthKey.string(from: selectedMonth) }
    private var title: String { selectedMonth.formatted(.dateTime.month(.wide).year()) }
    private var available: Double { max(0, income - savings - fixedCosts) }
    private var spent: Double {
        let calendar = Calendar.current
        return transactions.filter { calendar.isDate($0.occurredAt, equalTo: selectedMonth, toGranularity: .month) && $0.amount > 0 }.reduce(0) { $0 + $1.amount }
    }
    private var remaining: Double { available - spent }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                PaisaEyebrow(text: "Kakeibo monthly plan")
                HStack {
                    monthButton(-1, label: "Previous month", icon: "chevron.left")
                    Spacer()
                    Text(title).font(.title2.bold()).foregroundStyle(PaisaTheme.ink)
                    Spacer()
                    monthButton(1, label: "Next month", icon: "chevron.right")
                }

                VStack(alignment: .leading, spacing: 16) {
                    Text("Money available to live with").font(.subheadline).foregroundStyle(.white.opacity(0.72))
                    Text(PaisaFormat.amount(available)).font(.system(size: 38, weight: .bold, design: .rounded)).foregroundStyle(.white)
                    HStack(spacing: 12) {
                        summary("Spent", spent)
                        summary(remaining >= 0 ? "Remaining" : "Over plan", abs(remaining))
                    }
                    ProgressView(value: available > 0 ? min(spent / available, 1) : 0).tint(remaining >= 0 ? PaisaTheme.gold : PaisaTheme.peach)
                }
                .padding(22).background(PaisaTheme.forestDeep, in: RoundedRectangle(cornerRadius: 26))

                planField("1 · What is coming in?", "Monthly take-home income", value: $income)
                planField("2 · What do I want to keep?", "Savings before spending", value: $savings)
                planField("3 · What must be paid?", "Rent, bills, EMI and fixed costs", value: $fixedCosts)

                PaisaCard {
                    PaisaEyebrow(text: "4 · What should money make possible?")
                    TextField("A calm sentence, not a category list", text: $intention, axis: .vertical)
                        .lineLimit(2...4).padding(.top, 10)
                    Text("Example: Eat well, finish the trip fund, and avoid rushed purchases.").font(.caption).foregroundStyle(PaisaTheme.muted).padding(.top, 8)
                }

                PaisaCard {
                    PaisaEyebrow(text: "End-of-month reflection")
                    TextField("What went well? What would I change?", text: $reflection, axis: .vertical)
                        .lineLimit(3...6).padding(.top, 10)
                    Text("Reflection is optional. It is private financial context, not a score.").font(.caption).foregroundStyle(PaisaTheme.muted).padding(.top, 8)
                }

                Button { save() } label: {
                    Label("Save this month’s plan", systemImage: "checkmark")
                        .frame(maxWidth: .infinity).padding(15).fontWeight(.bold)
                }
                .buttonStyle(.borderedProminent).tint(PaisaTheme.forest)
                Text(sync.connected ? "Saved plans sync with your Paisa account." : "This plan stays on this iPhone until you sign in to sync.")
                    .font(.caption).foregroundStyle(PaisaTheme.muted).frame(maxWidth: .infinity, alignment: .center)
            }.padding(18)
        }
        .background(PaisaTheme.canvas.ignoresSafeArea())
        .navigationTitle("Plan")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(PaisaTheme.canvas, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task(id: month) {
            await sync.loadMoneyPlan(month: month, context: context)
            hydrate(force: true)
        }
        .onChange(of: plans.count) { _, _ in hydrate(force: false) }
    }

    private func summary(_ label: String, _ value: Double) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(PaisaFormat.amount(value)).font(.headline.bold()).foregroundStyle(.white)
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(1).foregroundStyle(.white.opacity(0.62))
        }.frame(maxWidth: .infinity, alignment: .leading).padding(12).background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
    }

    private func planField(_ title: String, _ prompt: String, value: Binding<Double>) -> some View {
        PaisaCard {
            PaisaEyebrow(text: title)
            TextField(prompt, value: value, format: .number).keyboardType(.decimalPad).font(.title2.bold()).padding(.top, 10)
        }
    }

    private func monthButton(_ delta: Int, label: String, icon: String) -> some View {
        Button { if let next = Calendar.current.date(byAdding: .month, value: delta, to: selectedMonth) { selectedMonth = next; hydratedMonth = "" } } label: {
            Image(systemName: icon).frame(width: 38, height: 38).background(PaisaTheme.surface, in: Circle())
        }.accessibilityLabel(label)
    }

    private func hydrate(force: Bool) {
        guard force || hydratedMonth != month, let plan = plans.first(where: { $0.month == month }) else { return }
        income = plan.income; savings = plan.plannedSavings; fixedCosts = plan.fixedCosts
        intention = plan.intention; reflection = plan.reflection; hydratedMonth = month
    }

    private func save() {
        let plan = plans.first(where: { $0.month == month }) ?? MonthlyMoneyPlan(month: month)
        if plan.modelContext == nil { context.insert(plan) }
        plan.income = max(0, income); plan.plannedSavings = max(0, savings); plan.fixedCosts = max(0, fixedCosts)
        plan.intention = intention.trimmingCharacters(in: .whitespacesAndNewlines); plan.reflection = reflection.trimmingCharacters(in: .whitespacesAndNewlines)
        plan.spent = spent; plan.needsSync = true; plan.updatedAt = .now; try? context.save()
        Task { await sync.saveMoneyPlan(plan, context: context) }
    }

    private static let monthKey: DateFormatter = { let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM"; return formatter }()
}
