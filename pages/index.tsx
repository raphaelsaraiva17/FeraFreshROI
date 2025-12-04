import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import dynamic from "next/dynamic";

// QRCode needs window, so we load it dynamically (Next.js safe)
const QRCode = dynamic(() => import("qrcode.react"), { ssr: false });

type LayoutMode = "desktop" | "mobile";
type EfficacyScenario = "conservative" | "base" | "optimistic";

interface HealthEventInput {
  name: string;
  key: string;
  count: number;
  costPerEvent: number;
}

interface CalculatorState {
  milkingCows: number;
  freshPerYear: number;
  freshOverride: boolean;
  replacementCost: number;
  salvageValue: number;
  milkPrice: number;
  lbMilkPerLbDM: number;
  dmCost: number;

  // Death / culling
  deathEvents: number;
  soldEvents: number;

  // Health events
  healthEvents: HealthEventInput[];
}

// Defaults taken from your Excel
const defaultHealthEvents: HealthEventInput[] = [
  { name: "Metritis", key: "metritis", count: 900, costPerEvent: 400 },
  { name: "Mastitis", key: "mastitis", count: 2500, costPerEvent: 400 },
  {
    name: "Clinical Hypocalcemia / Milk Fever",
    key: "milkFever",
    count: 150,
    costPerEvent: 275,
  },
  { name: "Ketosis", key: "ketosis", count: 600, costPerEvent: 200 },
  { name: "Retained Placenta", key: "retainedPlacenta", count: 400, costPerEvent: 330 },
  { name: "Displaced Abomasum", key: "da", count: 150, costPerEvent: 640 },
  { name: "Respiratory Disorders", key: "respiratory", count: 300, costPerEvent: 400 },
  { name: "Digestive Disorders", key: "digestive", count: 400, costPerEvent: 250 },
  { name: "Lameness", key: "lameness", count: 900, costPerEvent: 225 },
];

const defaultState: CalculatorState = {
  milkingCows: 10000, // B2
  freshPerYear: 13500, // will be recalculated to 135% in effect
  freshOverride: false,
  replacementCost: 3500, // B4
  salvageValue: 2000, // B5
  milkPrice: 20, // B6
  lbMilkPerLbDM: 1.8, // B7
  dmCost: 0.13, // B8

  deathEvents: 700, // B17
  soldEvents: 3000, // B25

  healthEvents: defaultHealthEvents,
};

interface ScenarioResult {
  scenario: EfficacyScenario;
  label: string;
  savingsAnnual: number;
  investmentAnnual: number;
  netProfitAnnual: number;
  roiRatio: number;
  returnPerCowYear: number;
  returnPerCowMonth: number;
  returnPerCowDay: number;
  monthsToBreakeven: number | null;
  daysToBreakeven: number | null;
}

// Base effect parameters taken from the workbook
const DEATH_REDUCTION_BASE = 0.113; // 11.3% less
const CULLING_VOLUNTARY_REDUCTION_BASE = 0.0666; // from Data
const CULLING_SOLD_REDUCTION_BASE = 0.113; // same 11.3% less
const HEALTH_EVENT_REDUCTION_BASE = 0.549; // 54.9% less
const PRODUCTION_GAIN_PERCENT_BASE = 4.94; // from H22

const SCENARIO_MULTIPLIERS: Record<EfficacyScenario, number> = {
  conservative: 0.75,
  base: 1.0,
  optimistic: 1.25,
};

const SCENARIO_LABELS: Record<EfficacyScenario, string> = {
  conservative: "Conservative",
  base: "Base",
  optimistic: "Optimistic",
};

function formatCurrency(x: number): string {
  if (!Number.isFinite(x)) return "-";
  return x.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function formatNumber(x: number, digits: number = 0): string {
  if (!Number.isFinite(x)) return "-";
  return x.toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function computeScenario(
  state: CalculatorState,
  scenario: EfficacyScenario
): ScenarioResult {
  const m = state.milkingCows;
  const fresh = state.freshOverride
    ? state.freshPerYear
    : Math.round(state.milkingCows * 1.35); // 135% default

  const mult = SCENARIO_MULTIPLIERS[scenario];

  // --- Death events ---
  const deathIncidence = state.deathEvents / m;
  const deathReduction = DEATH_REDUCTION_BASE * mult;
  const newDeathIncidence = deathIncidence * (1 - deathReduction);
  const newDeathEvents =
    deathIncidence === 0 ? state.deathEvents : (state.deathEvents * newDeathIncidence) / deathIncidence;
  const deathEventsAvoided = state.deathEvents - newDeathEvents;
  const deathSavings = deathEventsAvoided * state.salvageValue;

  // --- Culling section (mirrors B24-B29 logic conceptually) ---
  const cullingRate = (state.deathEvents + state.soldEvents) / fresh; // B24
  const soldRate = state.soldEvents / fresh; // B26
  const voluntaryReduction = CULLING_VOLUNTARY_REDUCTION_BASE * mult; // H26
  const soldReduction = CULLING_SOLD_REDUCTION_BASE * mult; // H27

  const newCullingRate = cullingRate * (1 - voluntaryReduction); // B27
  const newSoldRate = soldRate * (1 - soldReduction); // B28
  const cullingVoluntaryDeltaRate = soldRate - newSoldRate; // B26 - B28

  // Excel: B29 = ((B26-B28)*B25)*(B4-B5)
  const cullingSavings =
    cullingVoluntaryDeltaRate *
    state.soldEvents *
    (state.replacementCost - state.salvageValue);

  // --- Health events section (rows 34-42 approximate logic) ---
  const healthSavings = state.healthEvents.reduce((acc, ev) => {
    const reduction = HEALTH_EVENT_REDUCTION_BASE * mult;
    const eventsAvoided = ev.count * reduction;
    const savings = eventsAvoided * ev.costPerEvent;
    return acc + savings;
  }, 0);

  // --- Production / IOFC (H11-H18 logic) ---
  const gainPercent = PRODUCTION_GAIN_PERCENT_BASE * mult; // H11
  const extraRevenuePerCowDay = (gainPercent * state.milkPrice) / 100; // H14
  const extraDMLbPerCowDay = gainPercent / state.lbMilkPerLbDM; // H15
  const extraDMCostPerCowDay = extraDMLbPerCowDay * state.dmCost; // H16
  const netIOFCPerCowDay = extraRevenuePerCowDay - extraDMCostPerCowDay; // H17
  const productionSavingsAnnual = netIOFCPerCowDay * m * 210; // H18 (210 days)

  // --- Labor (H2-H7 logic, treated as ongoing investment) ---
  const wagePerHour = 20; // H2
  const monthlyHours = 22 * 30; // H3
  const laborChangeFraction = 0.1; // H4 (10% change)
  const changedHoursPerMonth = monthlyHours * laborChangeFraction; // H5
  const laborCostPerMonth = changedHoursPerMonth * wagePerHour; // H6
  const laborCostAnnual = laborCostPerMonth * 12; // H7

  // --- Investment (simplified version of C21) ---
  const costPerDose = 4.5; // B11
  const applicatorCost = 40; // B12
  const applicatorCount = 3; // B13
  const applicationsPerYear = 1; // B14

  // Approximate: doses for every fresh cow per application
  const productCostAnnual = m * costPerDose * applicationsPerYear;
  const applicatorInvestment = applicatorCost * applicatorCount;

  const investmentAnnual = productCostAnnual + applicatorInvestment + laborCostAnnual;

  // --- Total savings (annual) ---
  const totalSavingsAnnual =
    deathSavings +
    cullingSavings +
    healthSavings +
    productionSavingsAnnual;

  const netProfitAnnual = totalSavingsAnnual - investmentAnnual;
  const roiRatio =
    investmentAnnual > 0 ? totalSavingsAnnual / investmentAnnual : 0;

  const returnPerCowYear = netProfitAnnual / m;
  const returnPerCowMonth = returnPerCowYear / 12;
  const returnPerCowDay = returnPerCowMonth / 30;

  let monthsToBreakeven: number | null = null;
  let daysToBreakeven: number | null = null;
  if (totalSavingsAnnual > 0 && investmentAnnual > 0) {
    monthsToBreakeven = (investmentAnnual / totalSavingsAnnual) * 12;
    daysToBreakeven = (investmentAnnual / totalSavingsAnnual) * 365;
  }

  return {
    scenario,
    label: SCENARIO_LABELS[scenario],
    savingsAnnual: totalSavingsAnnual,
    investmentAnnual,
    netProfitAnnual,
    roiRatio,
    returnPerCowYear,
    returnPerCowMonth,
    returnPerCowDay,
    monthsToBreakeven,
    daysToBreakeven,
  };
}

export default function HomePage() {
  const [layout, setLayout] = useState<LayoutMode>("desktop");
  const [state, setState] = useState<CalculatorState>(defaultState);
  const [selectedScenario, setSelectedScenario] =
    useState<EfficacyScenario>("base");
  const [currentUrl, setCurrentUrl] = useState<string>("");

  useEffect(() => {
    if (typeof window !== "undefined") {
      setCurrentUrl(window.location.href);
    }
  }, []);

  const scenarios = useMemo(() => {
    return (["conservative", "base", "optimistic"] as EfficacyScenario[]).map(
      (s) => computeScenario(state, s)
    );
  }, [state]);

  const activeScenario = scenarios.find(
    (s) => s.scenario === selectedScenario
  )!;

  const handleNumberChange = (
    field: keyof CalculatorState,
    raw: string
  ) => {
    const value = raw === "" ? 0 : Number(raw);
    setState((prev) => ({
      ...prev,
      [field]: Number.isFinite(value) ? value : 0,
    }));
  };

  const handleFreshChange = (raw: string) => {
    const value = raw === "" ? 0 : Number(raw);
    setState((prev) => ({
      ...prev,
      freshPerYear: Number.isFinite(value) ? value : 0,
      freshOverride: true, // user has overridden the auto 135%
    }));
  };

  const handleHealthChange = (key: string, raw: string) => {
    const value = raw === "" ? 0 : Number(raw);
    setState((prev) => ({
      ...prev,
      healthEvents: prev.healthEvents.map((ev) =>
        ev.key === key
          ? {
              ...ev,
              count: Number.isFinite(value) ? value : 0,
            }
          : ev
      ),
    }));
  };

  // For displaying incidence and “health events follow % incidence”
  const fresh = state.freshOverride
    ? state.freshPerYear
    : Math.round(state.milkingCows * 1.35);

  const handlePrint = () => {
    if (typeof window !== "undefined") {
      window.print();
    }
  };

  const emailBody =
    encodeURIComponent(
      `FerAppease Fresh Cow ROI Summary\n\nLink: ${currentUrl}\n\nAnnual Net Profit (Base): ${formatCurrency(
        scenarios.find((s) => s.scenario === "base")!.netProfitAnnual
      )}\nAnnual ROI (Base): ${formatNumber(
        scenarios.find((s) => s.scenario === "base")!.roiRatio,
        2
      )} : 1`
    ) || "";

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Top bar */}
      <header className="border-b bg-white sticky top-0 z-20">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            {/* Replace with your actual logo paths */}
            <div className="flex items-center gap-2">
              <div className="relative w-10 h-10">
                <Image
                  src="/fera-logo.png"
                  alt="Fera AI"
                  fill
                  className="object-contain"
                />
              </div>
              <div className="relative w-10 h-10">
                <Image
                  src="/ferappease-logo.png"
                  alt="FerAppease"
                  fill
                  className="object-contain"
                />
              </div>
            </div>
            <div>
              <h1 className="font-semibold text-lg">
                FerAppease Fresh Cow ROI Calculator
              </h1>
              <p className="text-xs text-slate-500">
                Mirrors your Excel calculator with real-time ROI, health events &amp;
                sensitivity analysis.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Layout toggle */}
            <div className="inline-flex rounded-full bg-slate-100 p-1 text-xs">
              <button
                className={`px-3 py-1 rounded-full ${
                  layout === "desktop"
                    ? "bg-white shadow-sm text-slate-900"
                    : "text-slate-500"
                }`}
                onClick={() => setLayout("desktop")}
              >
                Desktop
              </button>
              <button
                className={`px-3 py-1 rounded-full ${
                  layout === "mobile"
                    ? "bg-white shadow-sm text-slate-900"
                    : "text-slate-500"
                }`}
                onClick={() => setLayout("mobile")}
              >
                Mobile
              </button>
            </div>

            {/* Link to Fera dairy page */}
            <a
              href="https://feraah.com/pages/ferappease-mbas-dairy"
              target="_blank"
              rel="noreferrer"
              className="hidden md:inline-flex text-xs px-3 py-1.5 rounded-full border border-emerald-500 text-emerald-700 hover:bg-emerald-50"
            >
              Fera Dairy &amp; FerAppease
            </a>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main
        className={`max-w-6xl mx-auto px-4 py-4 lg:py-6 ${
          layout === "desktop"
            ? "grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-6"
            : "flex flex-col gap-4"
        }`}
      >
        {/* LEFT: Inputs */}
        <section className="bg-white rounded-2xl shadow-sm border p-4 lg:p-6 print:hidden">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-sm lg:text-base">
              Herd &amp; Economic Inputs
            </h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-100">
              Editable fields = Excel light green
            </span>
          </div>

          {/* Herd basics */}
          <div className="grid md:grid-cols-2 gap-4 mb-5">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium">
                  Milking cows (B2)
                </label>
              </div>
              <input
                type="number"
                className="w-full border rounded-lg px-3 py-2 text-sm bg-lime-50"
                value={state.milkingCows}
                onChange={(e) =>
                  handleNumberChange("milkingCows", e.target.value)
                }
              />
              <p className="text-[11px] text-slate-500">
                Base herd size. Changing this will auto-update{" "}
                <strong>Fresh/year</strong> unless overridden.
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium">
                  Fresh/year (B3)
                </label>
                <button
                  className="text-[10px] px-2 py-0.5 rounded-full border border-slate-200 text-slate-500 hover:bg-slate-50"
                  onClick={() =>
                    setState((prev) => ({
                      ...prev,
                      freshOverride: false,
                      freshPerYear: Math.round(prev.milkingCows * 1.35),
                    }))
                  }
                >
                  Reset to 135% of milking cows
                </button>
              </div>
              <input
                type="number"
                className={`w-full border rounded-lg px-3 py-2 text-sm ${
                  state.freshOverride ? "bg-lime-50" : "bg-slate-50"
                }`}
                value={
                  state.freshOverride
                    ? state.freshPerYear
                    : Math.round(state.milkingCows * 1.35)
                }
                onChange={(e) => handleFreshChange(e.target.value)}
              />
              <p className="text-[11px] text-slate-500">
                Defaults to <strong>135% of milking cows</strong>. Once you
                change this field, the custom value is used.
              </p>
            </div>
          </div>

          {/* Economics row 2 */}
          <div className="grid md:grid-cols-4 gap-4 mb-4">
            <InputNumber
              label="Replacement $ (B4)"
              value={state.replacementCost}
              onChange={(v) => handleNumberChange("replacementCost", v)}
            />
            <InputNumber
              label="Cow salvage $ (B5)"
              value={state.salvageValue}
              onChange={(v) => handleNumberChange("salvageValue", v)}
            />
            <InputNumber
              label="Milk price $/cwt (B6)"
              value={state.milkPrice}
              onChange={(v) => handleNumberChange("milkPrice", v)}
            />
            <InputNumber
              label="lb Milk / lb DM (B7)"
              value={state.lbMilkPerLbDM}
              step="0.01"
              onChange={(v) => handleNumberChange("lbMilkPerLbDM", v)}
            />
          </div>

          <div className="grid md:grid-cols-4 gap-4 mb-6">
            <InputNumber
              label="DM cost $/lb (B8)"
              value={state.dmCost}
              step="0.01"
              onChange={(v) => handleNumberChange("dmCost", v)}
            />
            <InputNumber
              label="Death events / year (B17)"
              value={state.deathEvents}
              onChange={(v) => handleNumberChange("deathEvents", v)}
            />
            <InputNumber
              label="Sold events / year (B25)"
              value={state.soldEvents}
              onChange={(v) => handleNumberChange("soldEvents", v)}
            />
          </div>

          {/* Health events section */}
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Health events (rows 34–42)
            </h3>
            <span className="text-[10px] text-slate-400">
              Herd events follow % incidence (events ÷ Fresh/year)
            </span>
          </div>
          <div className="border rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-100">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Event</th>
                  <th className="text-right px-3 py-2 font-medium">
                    Events / year (B)
                  </th>
                  <th className="text-right px-3 py-2 font-medium">
                    Incidence %
                  </th>
                  <th className="text-right px-3 py-2 font-medium">
                    Cost / event ($)
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.healthEvents.map((ev, idx) => {
                  const incidence =
                    fresh > 0 ? (ev.count / fresh) * 100 : 0;
                  return (
                    <tr
                      key={ev.key}
                      className={idx % 2 === 0 ? "bg-white" : "bg-slate-50"}
                    >
                      <td className="px-3 py-1.5">{ev.name}</td>
                      <td className="px-3 py-1.5 text-right">
                        <input
                          type="number"
                          className="w-24 border rounded-md px-2 py-1 text-right bg-lime-50"
                          value={ev.count}
                          onChange={(e) =>
                            handleHealthChange(ev.key, e.target.value)
                          }
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right text-slate-600">
                        {formatNumber(incidence, 2)}%
                      </td>
                      <td className="px-3 py-1.5 text-right text-slate-600">
                        {formatCurrency(ev.costPerEvent)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Sensitivity control */}
          <div className="mt-6 border-t pt-4 flex flex-col md:flex-row justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
                Expected product efficacy
              </h3>
              <div className="inline-flex rounded-full bg-slate-100 p-1 text-xs">
                {(["conservative", "base", "optimistic"] as EfficacyScenario[]).map(
                  (s) => (
                    <button
                      key={s}
                      className={`px-3 py-1 rounded-full ${
                        selectedScenario === s
                          ? "bg-white shadow-sm text-emerald-700"
                          : "text-slate-500"
                      }`}
                      onClick={() => setSelectedScenario(s)}
                    >
                      {SCENARIO_LABELS[s]}
                    </button>
                  )
                )}
              </div>
              <p className="text-[11px] text-slate-500 mt-1">
                Efficacy adjusts all savings around the base Excel logic to
                visualize conservative / base / optimistic ROI.
              </p>
            </div>

            {/* Little horizontal “option bar” */}
            <div className="flex flex-col items-stretch md:items-end gap-1">
              <span className="text-[11px] text-slate-500">
                Slide focus between Conservative ⇄ Optimistic
              </span>
              <input
                type="range"
                min={0}
                max={2}
                step={1}
                value={
                  selectedScenario === "conservative"
                    ? 0
                    : selectedScenario === "base"
                    ? 1
                    : 2
                }
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setSelectedScenario(
                    v === 0
                      ? "conservative"
                      : v === 1
                      ? "base"
                      : "optimistic"
                  );
                }}
                className="w-56"
              />
              <div className="flex justify-between w-56 text-[10px] text-slate-500">
                <span>Cautious</span>
                <span>Most likely</span>
                <span>Aggressive</span>
              </div>
            </div>
          </div>
        </section>

        {/* RIGHT: Summary + charts + QR + PDF */}
        <section
          className="bg-white rounded-2xl shadow-sm border p-4 lg:p-6"
          id="roi-summary"
        >
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="font-semibold text-sm lg:text-base">
                ROI Summary – {activeScenario.label} Scenario
              </h2>
              <p className="text-[11px] text-slate-500">
                Based on your current inputs, applying FerAppease at fresh
                cows, with Excel-mirrored logic and sensitivity on product
                efficacy.
              </p>
            </div>
            <div className="flex flex-col items-end gap-1 text-right">
              <button
                onClick={handlePrint}
                className="text-xs px-3 py-1.5 rounded-full bg-slate-900 text-white hover:bg-slate-800 print:hidden"
              >
                Print / Save as PDF
              </button>
              <a
                href={`mailto:?subject=FerAppease%20Fresh%20Cow%20ROI%20Summary&body=${emailBody}`}
                className="text-[11px] text-emerald-700 hover:underline print:hidden"
              >
                Email this summary
              </a>
            </div>
          </div>

          {/* ROI key numbers */}
          <div className="grid grid-cols-2 gap-3 mb-4 text-xs lg:text-sm">
            <SummaryMetric
              label="Annual net profit"
              value={formatCurrency(activeScenario.netProfitAnnual)}
              emphasis
            />
            <SummaryMetric
              label="Annual ROI (benefit : cost)"
              value={`${formatNumber(activeScenario.roiRatio, 2)} : 1`}
              emphasis
            />
            <SummaryMetric
              label="Return / cow / year"
              value={formatCurrency(activeScenario.returnPerCowYear)}
            />
            <SummaryMetric
              label="Return / cow / day"
              value={formatCurrency(activeScenario.returnPerCowDay)}
            />
            <SummaryMetric
              label="Months to breakeven"
              value={
                activeScenario.monthsToBreakeven
                  ? formatNumber(activeScenario.monthsToBreakeven, 1)
                  : "-"
              }
            />
            <SummaryMetric
              label="Days to breakeven"
              value={
                activeScenario.daysToBreakeven
                  ? formatNumber(activeScenario.daysToBreakeven, 0)
                  : "-"
              }
            />
          </div>

          {/* Simple bar chart comparing scenarios (focus on ROI & net profit) */}
          <div className="mb-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
              Scenario comparison
            </h3>
            <div className="space-y-3">
              {scenarios.map((s) => {
                const maxNet = Math.max(
                  ...scenarios.map((x) => Math.max(0, x.netProfitAnnual))
                );
                const maxRoi = Math.max(
                  ...scenarios.map((x) => Math.max(0, x.roiRatio))
                );
                const netWidth =
                  maxNet > 0
                    ? (Math.max(0, s.netProfitAnnual) / maxNet) * 100
                    : 0;
                const roiWidth =
                  maxRoi > 0
                    ? (Math.max(0, s.roiRatio) / maxRoi) * 100
                    : 0;

                return (
                  <div key={s.scenario} className="space-y-1">
                    <div className="flex justify-between text-[11px] text-slate-500">
                      <span>{s.label}</span>
                      <span>
                        {formatCurrency(s.netProfitAnnual)} · ROI{" "}
                        {formatNumber(s.roiRatio, 2)} : 1
                      </span>
                    </div>
                    <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full bg-emerald-500/80"
                        style={{ width: `${netWidth}%` }}
                      />
                    </div>
                    <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full bg-sky-500/80"
                        style={{ width: `${roiWidth}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* QR + link area */}
          <div className="mt-4 flex flex-col lg:flex-row gap-4 lg:items-center">
            <div className="flex-1 text-[11px] text-slate-500">
              <p className="mb-1 font-medium text-slate-700">
                Share this calculator
              </p>
              <p className="mb-1">
                Once deployed to Vercel, this QR code will encode the current
                page URL so producers can open it directly on farm via phone.
              </p>
              <p className="mb-1">
                Current URL (dev or prod):{" "}
                <span className="font-mono break-all text-[10px]">
                  {currentUrl || "http://localhost:3000"}
                </span>
              </p>
              <a
                href="https://feraah.com/pages/ferappease-mbas-dairy"
                target="_blank"
                rel="noreferrer"
                className="inline-flex mt-1 text-emerald-700 hover:underline"
              >
                Learn more about FerAppease &amp; Fera Dairy
              </a>
            </div>
            <div className="flex-shrink-0 flex flex-col items-center gap-1 print:hidden">
              <div className="p-2 border rounded-xl bg-white">
                {currentUrl && (
                  <QRCode
                    value={currentUrl}
                    size={120}
                    includeMargin={true}
                  />
                )}
              </div>
              <span className="text-[10px] text-slate-500">
                Scan to open this ROI calculator
              </span>
            </div>
          </div>
        </section>
      </main>

      {/* Print style: only summary section */}
      <style jsx global>{`
        @media print {
          body {
            background: white !important;
          }
          header,
          .print\\:hidden {
            display: none !important;
          }
          #roi-summary {
            box-shadow: none !important;
            border: none !important;
          }
        }
      `}</style>
    </div>
  );
}

// Small helper components
function InputNumber(props: {
  label: string;
  value: number;
  step?: string;
  onChange: (v: string) => void;
}) {
  const { label, value, step, onChange } = props;
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium">{label}</label>
      <input
        type="number"
        className="w-full border rounded-lg px-3 py-2 text-sm bg-lime-50"
        value={value}
        step={step}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function SummaryMetric(props: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  const { label, value, emphasis } = props;
  return (
    <div className="border rounded-xl px-3 py-2 bg-slate-50/60">
      <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
        {label}
      </div>
      <div
        className={`${
          emphasis ? "text-base font-semibold text-emerald-700" : "text-sm"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

