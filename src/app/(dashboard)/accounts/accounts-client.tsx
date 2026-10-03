"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import type { AccountBundle } from "@/lib/data/repository";

function tierLabel(tier: string) {
  if (tier === "high") return "Tier A";
  if (tier === "medium") return "Tier B";
  if (tier === "low") return "Tier C";
  return "Unscored";
}

function formatAnalysisDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("en-GB") : "Not analyzed";
}

function AccountDetail({ bundle }: { bundle: AccountBundle }) {
  const { account, sources, contacts, contactPoints, intelligence } = bundle;
  return (
    <div className="space-y-5 text-sm">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Identity</p>
        <p className="mt-1 font-medium text-text">{account.canonicalName}</p>
        <p className="text-text-muted">
          {account.businessType.replace(/_/g, " ")} · {account.province ?? "no province"} · {account.city ?? "no city"}
        </p>
        <p className="mt-1 text-text-muted">{account.websiteUrl ?? "No website"}</p>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Source evidence</p>
        <ul className="mt-1 space-y-1">
          {sources.map((s) => (
            <li key={s.id} className="text-text-muted">
              {s.sourceType} — via {s.sourceProvider}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Contact graph</p>
        <ul className="mt-1 space-y-1">
          {contacts.map((c) => (
            <li key={c.id} className="text-text-muted">
              <span className="font-medium text-text">{c.fullName}</span> — {c.roleType.replace(/_/g, " ")}
              {c.isDecisionMaker ? <Badge variant="success" className="ml-2">decision maker</Badge> : null}
            </li>
          ))}
          {contacts.length === 0 ? <li className="text-text-muted">No named contacts yet.</li> : null}
        </ul>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Contact points</p>
        <ul className="mt-1 space-y-1">
          {contactPoints.map((cp) => (
            <li key={cp.id} className="text-text-muted">
              {cp.type}: {cp.value} — <Badge variant="neutral">{cp.verificationStatus}</Badge>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Fit & status</p>
        <p className="mt-1 text-text-muted">
          Score {intelligence?.fitScore ?? account.fitScore ?? "—"} ·
          <Badge variant={account.fitTier === "high" ? "success" : "neutral"}>{tierLabel(intelligence?.fitTier ?? account.fitTier)}</Badge> ·
          status {account.status.replace(/_/g, " ")}
        </p>
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Prospect intelligence</p>
        <p className="mt-1 text-text-muted">
          Confidence {intelligence?.confidence === null || intelligence?.confidence === undefined
            ? "—"
            : `${Math.round(intelligence.confidence * 100)}%`} · Last analyzed {formatAnalysisDate(intelligence?.lastAnalyzedAt)}
        </p>
        <p className="mt-2 text-text">{intelligence?.reasonSummary ?? "No structured reason available yet."}</p>
        {[
          ["Positive signals", intelligence?.positiveSignals ?? []],
          ["Negative signals", intelligence?.negativeSignals ?? []],
          ["Data missing", intelligence?.missingInformation ?? []],
          ["Risk flags", intelligence?.riskFlags ?? []],
        ].map(([label, values]) => (
          <div key={String(label)} className="mt-3">
            <p className="text-xs font-semibold text-text-muted">{String(label)}</p>
            <p className="mt-1 text-text-muted">{(values as string[]).length > 0 ? (values as string[]).join(" · ") : "None recorded"}</p>
          </div>
        ))}
        <ul className="mt-3 space-y-2">
          {(intelligence?.evidence ?? []).map((fact) => (
            <li key={fact.id} className="border-l-2 border-border pl-3 text-text-muted">
              <span className="font-medium text-text">{fact.type.replace(/_/g, " ")}: </span>{fact.value}
              {fact.sourceUrl ? <a className="ml-2 underline" href={fact.sourceUrl} target="_blank" rel="noreferrer">Source</a> : null}
            </li>
          ))}
        </ul>
      </div>

      <p className="border-t border-border pt-3 text-xs text-text-muted">
        Campaign membership, outreach history, conversations and dedup/merge history join this account once
        those services are wired to a persistent store — this demo shows the account/contact/source graph only.
      </p>
    </div>
  );
}

export function AccountsClient({ accountBundles }: { accountBundles: AccountBundle[] }) {
  const [selected, setSelected] = useState<AccountBundle | null>(null);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-text-muted">
            Synthetic Spanish accounts from dev seed mode, including a same-account-two-sources example
            (Farmacia Central Bilbao) and multi-decision-maker example. Click a row for the full account detail.
          </p>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeadCell>Business</TableHeadCell>
                <TableHeadCell>Type</TableHeadCell>
                <TableHeadCell>Province</TableHeadCell>
                <TableHeadCell>Contacts</TableHeadCell>
                <TableHeadCell>Sources</TableHeadCell>
                <TableHeadCell>Fit</TableHeadCell>
                <TableHeadCell>Reason</TableHeadCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {accountBundles.map((bundle) => {
                const { account, contacts, sources, intelligence } = bundle;
                return (
                  <TableRow key={account.id} className="cursor-pointer hover:bg-surface-muted" onClick={() => setSelected(bundle)}>
                    <TableCell className="font-medium text-text">{account.canonicalName}</TableCell>
                    <TableCell className="text-text-muted">{account.businessType.replace(/_/g, " ")}</TableCell>
                    <TableCell className="text-text-muted">{account.province ?? "—"}</TableCell>
                    <TableCell className="text-text-muted">{contacts.length}</TableCell>
                    <TableCell className="text-text-muted">{sources.length}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-text">{intelligence?.fitScore ?? account.fitScore ?? "—"}</span>
                        <Badge variant={account.fitTier === "high" ? "success" : "neutral"}>
                          {tierLabel(intelligence?.fitTier ?? account.fitTier)}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-text-muted">
                        {intelligence?.confidence === null || intelligence?.confidence === undefined
                          ? "No confidence"
                          : `${Math.round(intelligence.confidence * 100)}% confidence`} · {formatAnalysisDate(intelligence?.lastAnalyzedAt)}
                      </p>
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-text-muted">
                      {intelligence?.reasonSummary ?? "Not analyzed"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Sheet open={selected !== null} onClose={() => setSelected(null)} title={selected?.account.canonicalName ?? ""} description="Account detail">
        {selected ? <AccountDetail bundle={selected} /> : null}
      </Sheet>
    </>
  );
}
