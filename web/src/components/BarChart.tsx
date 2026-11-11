import { Bar, BarChart as RBarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Point = { label: string; value: number };

type Props = {
  data: Point[];
  color: string; // CSS değişkeni, ör. "var(--color-accent)"
  unit: string;
  height?: number;
  tickEvery?: number;
  ariaLabel: string;
};

const axisTick = { fill: "var(--color-ink-3)", fontSize: 10.5, fontFamily: "var(--font-mono)" };

export default function BarChart({ data, color, unit, height = 200, tickEvery = 1, ariaLabel }: Props) {
  return (
    <div role="img" aria-label={ariaLabel} style={{ width: "100%", height }}>
      <ResponsiveContainer>
        <RBarChart data={data} margin={{ top: 6, right: 16, bottom: 0, left: -18 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke="var(--color-edge-soft)" />
          <XAxis
            dataKey="label"
            tick={axisTick}
            tickLine={false}
            axisLine={{ stroke: "var(--color-edge)" }}
            interval={tickEvery - 1}
          />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: "var(--color-edge-soft)" }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <div className="rounded-md bg-ink px-2.5 py-1.5 font-mono text-xs text-canvas shadow">
                  {label}: {payload[0].value} {unit}
                </div>
              ) : null
            }
          />
          <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </RBarChart>
      </ResponsiveContainer>
    </div>
  );
}
