import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import { KpiStat } from "@/components/dashboard/kpi-stat";
import { getSearchSeeds } from "@/lib/data/repository";

const ENGINE_LABELS: Record<string, string> = {
  maps_fast: "Maps Fast",
  maps_deep: "Maps Deep",
  google_serp: "Google SERP",
  linkedin_owner: "LinkedIn Owner",
  hybrid_fill: "Hybrid Fill",
};

function yieldVariant(yieldRate: number): "success" | "warning" | "danger" {
  if (yieldRate >= 0.4) return "success";
  if (yieldRate >= 0.2) return "warning";
  return "danger";
}

export default async function DiscoveryPage() {
  const seedSearchSeeds = await getSearchSeeds();
  const totalRaw = seedSearchSeeds.reduce((sum, s) => sum + s.totalRaw, 0);
  const totalReady = seedSearchSeeds.reduce((sum, s) => sum + s.totalReady, 0);
  const exhausted = seedSearchSeeds.filter((s) => s.exhaustionScore >= 0.8).length;
  const geographies = new Set(seedSearchSeeds.map((s) => s.geography)).size;
  const avgYield = seedSearchSeeds.length
    ? Math.round((seedSearchSeeds.reduce((sum, s) => sum + s.yieldRate, 0) / seedSearchSeeds.length) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-text">Discovery</h2>
        <p className="text-sm text-text-muted">
          Search-seed coverage and yield across every discovery engine and geography. Near-exhausted seeds are
          flagged so new geographies or query variants can be added before an engine starves.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <KpiStat label="Search seeds" value={String(seedSearchSeeds.length)} />
        <KpiStat label="Geographies" value={String(geographies)} />
        <KpiStat label="Raw discovered" value={String(totalRaw)} />
        <KpiStat label="Outreach-ready" value={String(totalReady)} emphasize />
        <KpiStat label="Avg. yield" value={`${avgYield}%`} />
      </div>

      {exhausted > 0 ? (
        <Card className="border-warning">
          <CardContent className="py-3 text-sm text-warning">
            {exhausted} search seed{exhausted === 1 ? " is" : "s are"} near exhaustion (≥80% exhaustion score) —
            consider adding new geographies or query variants for that engine.
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Search seed coverage</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeadCell>Engine</TableHeadCell>
                <TableHeadCell>Query</TableHeadCell>
                <TableHeadCell>Geography</TableHeadCell>
                <TableHeadCell>Raw</TableHeadCell>
                <TableHeadCell>Unique</TableHeadCell>
                <TableHeadCell>Ready</TableHeadCell>
                <TableHeadCell>Yield</TableHeadCell>
                <TableHeadCell>Exhaustion</TableHeadCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {seedSearchSeeds.map((seed) => (
                <TableRow key={seed.id}>
                  <TableCell>{ENGINE_LABELS[seed.engineType] ?? seed.engineType}</TableCell>
                  <TableCell className="text-text-muted">{seed.query}</TableCell>
                  <TableCell className="text-text-muted">{seed.geography}</TableCell>
                  <TableCell>{seed.totalRaw}</TableCell>
                  <TableCell>{seed.totalUnique}</TableCell>
                  <TableCell className="font-medium text-text">{seed.totalReady}</TableCell>
                  <TableCell>
                    <Badge variant={yieldVariant(seed.yieldRate)}>{Math.round(seed.yieldRate * 100)}%</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={seed.exhaustionScore >= 0.8 ? "danger" : "neutral"}>
                      {Math.round(seed.exhaustionScore * 100)}%
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

