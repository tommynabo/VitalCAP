import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { seedAccountBundles } from "@/lib/seed/dev-seed";

export default function ContactsPage() {
  const contacts = seedAccountBundles.flatMap(({ account, contacts: accountContacts }) =>
    accountContacts.map((contact) => ({ contact, accountName: account.canonicalName })),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Contacts</CardTitle>
        <Badge variant="primary">Seed data · Prompt 1 finalizes schema</Badge>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-text-muted">
          Named decision makers from dev seed mode. Generic account-level endpoints (e.g. info@) are not
          listed here as people — see the Accounts page for the full contact-point graph once Phase 1 ships.
        </p>
        <div className="overflow-x-auto rounded-[10px] border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-muted text-xs uppercase tracking-wide text-text-muted">
              <tr>
                <th className="px-4 py-2">Person</th>
                <th className="px-4 py-2">Account</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Decision maker</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map(({ contact, accountName }) => (
                <tr key={contact.id} className="border-t border-border">
                  <td className="px-4 py-2 font-medium text-text">{contact.fullName}</td>
                  <td className="px-4 py-2 text-text-muted">{accountName}</td>
                  <td className="px-4 py-2 text-text-muted">{contact.roleType.replace(/_/g, " ")}</td>
                  <td className="px-4 py-2">
                    <Badge variant={contact.isDecisionMaker ? "success" : "neutral"}>
                      {contact.isDecisionMaker ? "Yes" : "No"}
                    </Badge>
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
