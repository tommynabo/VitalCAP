import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getOffer } from "@/lib/data/repository";

export default async function SettingsPage() {
  const seedOffer = await getOffer();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-text">Settings</h2>
        <p className="text-sm text-text-muted">
          Workspace, user and offer/commercial-fact configuration. No commercial fact — price, margin, booking
          URL, claims — is ever hard-coded in application code; it all lives in the <code>Offer</code> record
          shown below.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-sm">
          <span className="text-text-muted">Workspace ID</span>
          <span className="text-right text-text">ws_demo</span>
          <span className="text-text-muted">Country</span>
          <span className="text-right text-text">Spain (ES)</span>
          <span className="text-text-muted">Delivery mode</span>
          <span className="text-right"><Badge variant="warning">dry_run (default)</Badge></span>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Offer / commercial facts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {seedOffer ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <span className="text-text-muted">Name</span>
                <span className="text-right text-text">{seedOffer.name}</span>
                <span className="text-text-muted">Company</span>
                <span className="text-right text-text">{seedOffer.company}</span>
                <span className="text-text-muted">Primary CTA</span>
                <span className="text-right text-text">{seedOffer.primaryCta}</span>
                <span className="text-text-muted">Active</span>
                <span className="text-right"><Badge variant={seedOffer.active ? "success" : "neutral"}>{seedOffer.active ? "Active" : "Inactive"}</Badge></span>
              </div>
              <p className="text-text-muted">{seedOffer.description}</p>
              <div>
                <p className="mb-1 text-xs font-medium text-text-muted">Forbidden claims</p>
                <div className="flex flex-wrap gap-1">
                  {seedOffer.forbiddenClaims.map((claim) => (
                    <Badge key={claim} variant="danger">
                      {claim.replace(/_/g, " ")}
                    </Badge>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <p className="text-text-muted">No offer configured for this workspace yet.</p>
          )}
          <p className="border-t border-border pt-3 text-xs text-text-muted">
            Editing offer facts requires a persistent store and is not wired in this demo build — see the
            master prompt Appendix for the full `Offer` schema.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>User profile</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-sm">
          <span className="text-text-muted">Name</span>
          <span className="text-right text-text">Operator (demo)</span>
          <span className="text-text-muted">Role</span>
          <span className="text-right text-text">Workspace admin</span>
        </CardContent>
      </Card>
    </div>
  );
}

