import { User, AtSign } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import { getAccountBundles } from "@/lib/data/repository";

export default async function ContactsPage() {
  const accountBundles = await getAccountBundles();
  const namedContacts = accountBundles.flatMap(({ account, contacts: accountContacts }) =>
    accountContacts.map((contact) => ({ kind: "named" as const, contact, accountName: account.canonicalName })),
  );

  const genericEndpoints = accountBundles.flatMap(({ account, contactPoints }) =>
    contactPoints
      .filter((cp) => cp.isGeneric && !cp.contactId)
      .map((cp) => ({ kind: "generic" as const, contactPoint: cp, accountName: account.canonicalName })),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Contacts</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-text-muted">
          Named decision makers are shown with a person badge; generic account-level endpoints (e.g. info@,
          switchboard numbers) are shown muted below with a mailbox badge — they are channel endpoints, not people.
        </p>
        <Table>
          <TableHead>
            <TableRow>
              <TableHeadCell>Contact</TableHeadCell>
              <TableHeadCell>Account</TableHeadCell>
              <TableHeadCell>Role</TableHeadCell>
              <TableHeadCell>Decision maker</TableHeadCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {namedContacts.map(({ contact, accountName }) => (
              <TableRow key={contact.id}>
                <TableCell className="font-medium text-text">
                  <span className="inline-flex items-center gap-1.5">
                    <User className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                    {contact.fullName}
                  </span>
                </TableCell>
                <TableCell className="text-text-muted">{accountName}</TableCell>
                <TableCell className="text-text-muted">{contact.roleType.replace(/_/g, " ")}</TableCell>
                <TableCell>
                  <Badge variant={contact.isDecisionMaker ? "success" : "neutral"}>
                    {contact.isDecisionMaker ? "Yes" : "No"}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
            {genericEndpoints.map(({ contactPoint, accountName }) => (
              <TableRow key={contactPoint.id} className="opacity-70">
                <TableCell className="text-text-muted">
                  <span className="inline-flex items-center gap-1.5">
                    <AtSign className="h-3.5 w-3.5" aria-hidden="true" />
                    {contactPoint.value}
                  </span>
                </TableCell>
                <TableCell className="text-text-muted">{accountName}</TableCell>
                <TableCell>
                  <Badge variant="neutral">Generic endpoint</Badge>
                </TableCell>
                <TableCell className="text-text-muted">—</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

