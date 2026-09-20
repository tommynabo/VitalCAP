import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { seedAccountBundles } from "@/lib/seed/dev-seed";

export default function AccountsPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Accounts</CardTitle>
        <Badge variant="primary">Seed data · Prompt 1 finalizes schema</Badge>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-text-muted">
          Synthetic Spanish accounts from dev seed mode, including a same-account-two-sources example
          (Farmacia Central Bilbao) and multi-decision-maker example. Full account detail drawer, dedup/merge
          history and outreach state ship in Phase 5.
        </p>
        <div className="overflow-x-auto rounded-[10px] border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-muted text-xs uppercase tracking-wide text-text-muted">
              <tr>
                <th className="px-4 py-2">Business</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Province</th>
                <th className="px-4 py-2">Contacts</th>
                <th className="px-4 py-2">Sources</th>
                <th className="px-4 py-2">Fit</th>
              </tr>
            </thead>
            <tbody>
              {seedAccountBundles.map(({ account, contacts, sources }) => (
                <tr key={account.id} className="border-t border-border">
                  <td className="px-4 py-2 font-medium text-text">{account.canonicalName}</td>
                  <td className="px-4 py-2 text-text-muted">{account.businessType.replace(/_/g, " ")}</td>
                  <td className="px-4 py-2 text-text-muted">{account.province ?? "—"}</td>
                  <td className="px-4 py-2 text-text-muted">{contacts.length}</td>
                  <td className="px-4 py-2 text-text-muted">{sources.length}</td>
                  <td className="px-4 py-2">
                    <Badge variant={account.fitTier === "high" ? "success" : "neutral"}>{account.fitTier}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
