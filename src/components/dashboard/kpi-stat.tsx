import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils/cn";

export function KpiStat({
  label,
  value,
  suffix,
  emphasize,
}: {
  label: string;
  value: string;
  suffix?: string;
  emphasize?: boolean;
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-xs font-medium text-text-muted">{label}</p>
        <p className={cn("mt-1 text-2xl font-semibold tracking-tight text-text", emphasize && "text-primary")}>
          {value}
          {suffix ? <span className="ml-1 text-sm font-medium text-text-muted">{suffix}</span> : null}
        </p>
      </CardContent>
    </Card>
  );
}
