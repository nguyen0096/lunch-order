import { useCallback, useEffect, useId, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  Action,
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Skeleton,
  useAction,
} from "@/ui";
import {
  createInvitation,
  fetchInvitations,
  fetchJoinCode,
  fetchOrgMembers,
  generateJoinCode,
  humanError,
  revokeInvitation,
  setJoinCode,
  updateMembership,
  type Invitation,
  type JoinCode,
  type OrgMember,
} from "../api.js";
import { now as appNow } from "../../shared/clock.js";
import { botDeepLink } from "../../shared/telegram.js";
import type { Role } from "../../shared/types.js";
import type { ScreenProps } from "./screenProps.js";

/**
 * Get somebody in, and notice somebody who should not be.
 *
 * The code leads because it is how almost everybody actually joins: they are
 * sent it in the group chat, they send it to the bot, and they never have an
 * email address for the app to invite. Email invitations still work, one column
 * over, for the person who needs a link instead.
 *
 * Recent joins sit under the code because that pairing *is* the security model.
 * A permanent shared code will eventually reach somebody it should not, so this
 * screen is built to make that visible rather than to pretend it is prevented:
 * an admin who opens it to manage people reads a list of names and times, and an
 * unfamiliar name is the signal. See docs/explanation/join-codes.md.
 *
 * Every control that cannot be used says so in words. This screen is the reason
 * that rule exists: it spent a week looking broken while working exactly as
 * designed, because a row of grey buttons says "this app is broken" and never
 * says "only an owner can do that".
 */
export function PeopleScreen({ me, org, role }: ScreenProps) {
  const iAmOwner = role === "owner";

  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [code, setCode] = useState<JoinCode | null>(null);
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Captured with the data rather than read during render, so "3 minutes ago"
  // is measured from one instant and every row on the screen agrees.
  const [now, setNow] = useState(() => appNow());
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      const [nextMembers, nextCode, nextInvitations] = await Promise.all([
        fetchOrgMembers({ orgId: org.id, meProfileId: me.profileId }),
        fetchJoinCode(org.id),
        fetchInvitations(org.id),
      ]);
      setMembers(nextMembers);
      setCode(nextCode);
      setInvitations(nextInvitations);
      setNow(appNow());
      setLoadError(null);
    } catch (e) {
      // useAction owns every write. A read has no toast to fire and nothing to
      // put back, so its failure is a state this screen renders instead.
      setLoadError(humanError(e));
    }
  }, [org.id, me.profileId]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ------------------------------------------------------------- mutations */

  const rotate = useAction(
    async (a: { first: boolean }) => {
      const next = await setJoinCode({ orgId: org.id, code: generateJoinCode() });
      return { ...next, first: a.first };
    },
    {
      // Same verb through the flow: Create produces Created, Rotate Rotated.
      success: (d) => (d.first ? "Created" : "Rotated"),
      onSuccess: (d) => {
        setCode({ code: d.code, setAt: d.setAt });
        setNow(appNow());
        setConfirming(false);
      },
    },
  );

  const copy = useAction(copyToClipboard, { success: "Copied" });

  const changeRole = useAction(
    async (a: { member: OrgMember; role: Role }) => {
      await updateMembership({ membershipId: a.member.membershipId, role: a.role });
      return a;
    },
    {
      success: (a) => `${a.member.name} is now ${withArticle(a.role)}`,
      onSuccess: () => void load(),
    },
  );

  const changeStatus = useAction(
    async (a: { member: OrgMember; status: "active" | "inactive" }) => {
      await updateMembership({ membershipId: a.member.membershipId, status: a.status });
      return a;
    },
    {
      success: (a) =>
        a.status === "inactive" ? `Deactivated ${a.member.name}` : `Reactivated ${a.member.name}`,
      onSuccess: () => void load(),
    },
  );

  const invite = useAction(
    async (a: { email: string; role: "member" | "admin" }) =>
      createInvitation({
        orgId: org.id,
        email: a.email,
        role: a.role,
        invitedBy: me.profileId,
      }),
    { success: (inv) => `Invited ${inv.email}`, onSuccess: () => void load() },
  );

  const revoke = useAction(
    async (inv: Invitation) => {
      await revokeInvitation(inv.id);
      return inv;
    },
    { success: (inv) => `Revoked ${inv.email}`, onSuccess: () => void load() },
  );

  const busy = changeRole.pending || changeStatus.pending;

  /* ------------------------------------------------------------- rendering */

  if (loadError !== null) {
    return (
      <EmptyState
        heading="The people screen did not load"
        action={
          <Button variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        }
      >
        {loadError}
      </EmptyState>
    );
  }

  if (members === null || code === null || invitations === null) return <PeopleSkeleton />;

  const recent = [...members].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
  const waiting = invitations.filter((i) => i.acceptedAt === null);
  const activeCount = members.filter((m) => m.status === "active").length;

  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] lg:items-start">
      <div className="flex flex-col gap-6">
        <JoinCodePanel
          code={code}
          orgName={org.name}
          timeZone={org.timezone}
          now={now}
          pending={rotate.pending}
          copying={copy.pending}
          onCopy={(text) => void copy.run(text)}
          onCreate={() => void rotate.run({ first: true })}
          onAskRotate={() => setConfirming(true)}
        />

        <RecentJoins
          members={recent}
          alone={members.length <= 1}
          timeZone={org.timezone}
          now={now}
        />
      </div>

      <InvitePanel
        invitations={waiting}
        timeZone={org.timezone}
        now={now}
        onCopy={(text) => void copy.run(text)}
        sending={invite.pending}
        revoking={revoke.pending}
        onInvite={(a) => void invite.run(a)}
        onRevoke={(inv) => void revoke.run(inv)}
      />

      <section aria-labelledby="people-members" className="lg:col-span-2">
        <h2 id="people-members" className="text-lg font-semibold">
          Members
        </h2>
        <p className="mt-1 text-sm text-muted">
          {`${activeCount} active in ${org.name}. Deactivating somebody stops every request they make from their next one; their past orders stay on the bill, because they ate the food.`}
        </p>

        {members.length === 0 ? (
          <EmptyState heading="Nobody in this office yet" className="mt-3">
            Share the join code above to add your first colleague.
          </EmptyState>
        ) : (
          <ul
            aria-label="Members"
            className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface-raised"
          >
            {members.map((member) => (
              <MemberRow
                key={member.membershipId}
                member={member}
                iAmOwner={iAmOwner}
                busy={busy}
                onRole={(next) => void changeRole.run({ member, role: next })}
                onStatus={(status) => void changeStatus.run({ member, status })}
              />
            ))}
          </ul>
        )}
      </section>

      <RotateDialog
        open={confirming}
        onOpenChange={setConfirming}
        pending={rotate.pending}
        onConfirm={() => void rotate.run({ first: false })}
      />
    </div>
  );
}

/* ------------------------------------------------------------------- panels */

/**
 * The code, set large, with everything an admin does to it in one place.
 *
 * Three ways to hand it over, because all three happen: read aloud, pasted into
 * the group chat, and scanned off the admin's screen by whoever is standing
 * there. The QR carries the bot's `/start CODE` deep link rather than the bare
 * string, so scanning it lands in the conversation that can actually act on it.
 */
function JoinCodePanel({
  code,
  orgName,
  timeZone,
  now,
  pending,
  copying,
  onCopy,
  onCreate,
  onAskRotate,
}: {
  code: JoinCode;
  orgName: string;
  timeZone: string;
  now: Date;
  pending: boolean;
  copying: boolean;
  onCopy: (text: string) => void;
  onCreate: () => void;
  onAskRotate: () => void;
}) {
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-border bg-surface-raised p-4 md:p-6"
    >
      <h2 id={headingId} className="text-lg font-semibold">
        Join code
      </h2>

      {code.code === null ? (
        <EmptyState
          heading="No join code yet"
          className="mt-3"
          action={
            <Action reason={null} pending={pending} onClick={onCreate}>
              Create a join code
            </Action>
          }
        >
          {`Nobody can join ${orgName} from Telegram until there is one. Making it takes a moment, and you can rotate it whenever you like.`}
        </EmptyState>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted">
            {`Anyone who has this can join ${orgName} as a member, and only ever as a member. It does not expire, so rotate it once it has reached somebody outside the office.`}
          </p>

          <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-6">
            <div className="min-w-0 flex-1">
              <p className="text-2xl font-semibold tracking-widest break-all text-text tabular md:text-3xl">
                {code.code}
              </p>

              <p className="mt-2 text-sm text-muted">
                {code.setAt === null ? (
                  // Not "never set", and not a made-up date: this code predates
                  // the column that records the answer, and saying so is honest.
                  "Set before this was recorded. Rotating it starts the clock."
                ) : (
                  <span title={absoluteLabel(code.setAt, timeZone)}>
                    {`Set ${sinceLabel(code.setAt, now, timeZone)}`}
                  </span>
                )}
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
                <Action
                  reason={null}
                  pending={copying}
                  variant="outline"
                  onClick={() => onCopy(code.code ?? "")}
                >
                  Copy
                </Action>
                <Action reason={null} pending={pending} variant="outline" onClick={onAskRotate}>
                  Rotate
                </Action>
              </div>
            </div>

            <JoinQr code={code.code} orgName={orgName} />
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The code as something a colleague points a phone at.
 *
 * It encodes the bot's deep link, not the bare code: the code on its own scans
 * to a string the person then has to carry somewhere by hand, which is the work
 * the QR was there to remove. A build with no bot username has no link to make,
 * so it degrades the way the Telegram section of Settings does -- to the raw
 * `/start` command, which is the same instruction one step less convenient.
 */
function JoinQr({ code, orgName }: { code: string; orgName: string }) {
  // Read at render, so a build with a bot username and one without take the
  // same path through here.
  const bot = (import.meta.env.VITE_TELEGRAM_BOT ?? "").trim();
  const link = botDeepLink(bot, code);

  if (link === null) {
    return (
      <div className="shrink-0 sm:max-w-64">
        <p className="text-sm text-muted">
          This app was built with no bot username, so there is nothing to scan. Whoever is joining
          sends this to your office&apos;s lunch bot instead.
        </p>
        <code className="mt-2 block truncate rounded-md bg-surface-sunken px-3 py-2 font-mono text-sm">
          {`/start ${code}`}
        </code>
      </div>
    );
  }

  return (
    <figure className="flex shrink-0 flex-col items-center gap-2">
      {/* The plate keeps dark modules on a light field in BOTH themes, which is
          the polarity every scanner assumes. Inheriting the surface would invert
          the code after dark, and an inverted QR is one a phone may refuse. */}
      <div className="w-fit rounded-lg bg-accent-subtle p-3 text-accent-subtle-fg dark:bg-accent dark:text-accent-fg">
        <QRCodeSVG
          value={link}
          // The specification's four-module quiet zone. The library defaults to
          // none, which reads on a phone held still and fails on one held at an
          // angle.
          marginSize={4}
          // M survives a fingerprint on the screen; H would push a longer link
          // into a denser version for no gain at this size.
          level="M"
          size={160}
          bgColor="transparent"
          fgColor="currentColor"
          title={`Join ${orgName} on Telegram with code ${code}`}
          className="h-auto w-40"
        />
      </div>
      <figcaption className="max-w-40 text-center text-xs text-muted">
        Scanning opens the bot with this code already typed.
      </figcaption>
    </figure>
  );
}

/**
 * Rotating breaks the code for everybody still holding it, including anyone
 * halfway through joining, so it asks first and says exactly what changes --
 * including the part people get wrong, which is that it removes nobody.
 */
function RotateDialog({
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate the join code?</DialogTitle>
          <DialogDescription>
            The current code stops working straight away, so anybody holding it who has not joined
            yet will need the new one. Everybody already in the office keeps their access: rotating
            removes nobody. To remove somebody, deactivate them in the member list.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Keep the current code</Button>
          </DialogClose>
          <Action reason={null} pending={pending} variant="danger" onClick={onConfirm}>
            Rotate
          </Action>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The safety mechanism, not a changelog. A leaked code is noticed rather than
 * prevented, and this is where it gets noticed, so it sits directly under the
 * code and names people newest first.
 */
function RecentJoins({
  members,
  alone,
  timeZone,
  now,
}: {
  members: OrgMember[];
  alone: boolean;
  timeZone: string;
  now: Date;
}) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="text-lg font-semibold">
        Recent joins
      </h2>
      <p className="mt-1 text-sm text-muted">
        A shared code is watched rather than locked. A name here you do not recognise is the signal
        to rotate the code and deactivate them.
      </p>

      {alone ? (
        <EmptyState heading="Nobody else has joined yet" className="mt-3">
          Share this to add your first colleague.
        </EmptyState>
      ) : (
        <ul
          aria-label="Recent joins"
          className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface-raised"
        >
          {members.map((m) => (
            <li
              key={m.membershipId}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3"
            >
              <span className="font-medium">{m.name}</span>
              {m.isMe && <span className="text-sm text-muted">(you)</span>}
              {m.role !== "member" && <Badge variant="outline">{m.role}</Badge>}
              {m.status === "inactive" && <Badge variant="warn">inactive</Badge>}
              <span
                className="ml-auto text-sm text-muted"
                title={absoluteLabel(m.createdAt, timeZone)}
              >
                {`Joined ${sinceLabel(m.createdAt, now, timeZone)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The second way in, and deliberately the smaller one. An invitation is keyed
 * on an email address, and most members of this app do not have one: they came
 * from Telegram, where the code is the entire mechanism.
 */
function InvitePanel({
  invitations,
  timeZone,
  now,
  sending,
  revoking,
  onInvite,
  onRevoke,
  onCopy,
}: {
  invitations: Invitation[];
  timeZone: string;
  now: Date;
  sending: boolean;
  revoking: boolean;
  onInvite: (a: { email: string; role: "member" | "admin" }) => void;
  onRevoke: (inv: Invitation) => void;
  onCopy: (text: string) => void;
}) {
  const headingId = useId();
  const emailId = useId();
  const roleId = useId();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div>
        <h2 id={headingId} className="text-lg font-semibold">
          Invite by email
        </h2>
        <p className="mt-1 text-sm text-muted">
          For somebody who wants a link rather than the code. An invitation names one address and
          can appoint an admin, which the code never can.
        </p>
      </div>

      <form
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = email.trim();
          if (trimmed === "") return;
          onInvite({ email: trimmed, role });
          setEmail("");
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={emailId} className="text-sm font-medium">
            Email address
          </label>
          <input
            id={emailId}
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ten@congty.vn"
            className="h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-text placeholder:text-subtle"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={roleId} className="text-sm font-medium">
            Role
          </label>
          {/* member and admin only. An invitation can never mint an owner, which
              is the database's rule as much as this screen's. */}
          <select
            id={roleId}
            value={role}
            onChange={(e) => setRole(e.target.value === "admin" ? "admin" : "member")}
            className="h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-text"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </div>

        <Action reason={null} pending={sending} type="submit" variant="outline">
          Invite
        </Action>
      </form>

      {invitations.length === 0 ? (
        <EmptyState heading="No invitations waiting">
          Everybody here joined with the code. Send one above when somebody needs a link instead.
        </EmptyState>
      ) : (
        <ul
          aria-label="Invitations"
          className="divide-y divide-border rounded-lg border border-border bg-surface-raised"
        >
          {invitations.map((inv) => {
            const expired = Date.parse(inv.expiresAt) <= now.getTime();
            return (
              <li key={inv.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{inv.email}</p>
                  <p className="text-sm text-muted" title={absoluteLabel(inv.expiresAt, timeZone)}>
                    {expired
                      ? `${inv.role} · expired ${sinceLabel(inv.expiresAt, now, timeZone)}`
                      : `${inv.role} · expires ${untilLabel(inv.expiresAt, now, timeZone)}`}
                  </p>
                </div>
                <Action
                  reason={expired ? "This invitation has expired. Send a new one" : null}
                  size="sm"
                  variant="outline"
                  onClick={() => onCopy(invitationLink(inv.token))}
                >
                  Copy link
                </Action>
                <Action
                  reason={null}
                  pending={revoking}
                  size="sm"
                  variant="outline"
                  onClick={() => onRevoke(inv)}
                >
                  Revoke
                </Action>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------- member */

/**
 * One person, their role, and every control that acts on them.
 *
 * A list rather than a table: the board is a grid of people by days and has to
 * be one, but this is a person with three attributes and a few buttons, and a
 * table of that at 390px is a horizontal scroll with the controls hidden off
 * the right edge.
 */
function MemberRow({
  member,
  iAmOwner,
  busy,
  onRole,
  onStatus,
}: {
  member: OrgMember;
  iAmOwner: boolean;
  busy: boolean;
  onRole: (role: Role) => void;
  onStatus: (status: "active" | "inactive") => void;
}) {
  // Two different kinds of "you cannot do that", and they want different
  // treatment. Whether you may stand THIS person down depends on the row --
  // your own, or the owner's -- so the control stays and states its reason,
  // because hiding it on some rows and not others reads as arbitrary.
  // Appointing an owner depends on nothing but your own role: an admin can
  // never do it, on any row, ever. That is not a disabled control, it is a
  // control that is not theirs, and we already handle those by absence -- a
  // member sees no Menu tab rather than a greyed one.
  const others = ROLES.filter((r) => r !== member.role && (iAmOwner || r !== "owner"));
  const deactivating = member.status === "active";

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="truncate font-medium">{member.name}</span>
          {member.isMe && <span className="text-sm text-muted">(you)</span>}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted">
          <Badge variant={member.role === "member" ? "neutral" : "accent"}>{member.role}</Badge>
          {member.status === "inactive" && <Badge variant="warn">inactive</Badge>}
          {/* Most members joined from Telegram and have no email at all, so the
              short code -- the one that appears in a bank transfer memo -- is
              the identifier that is always there. */}
          <span className="tabular">{member.shortCode}</span>
          {member.email !== "" && <span className="truncate">{member.email}</span>}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {others.map((target) => (
          <Action
            key={target}
            reason={roleReason({ member, target, iAmOwner })}
            pending={busy}
            size="sm"
            variant="outline"
            onClick={() => onRole(target)}
          >
            {`Make ${target}`}
          </Action>
        ))}
        <Action
          reason={statusReason({ member, iAmOwner })}
          pending={busy}
          size="sm"
          variant="outline"
          onClick={() => onStatus(deactivating ? "inactive" : "active")}
        >
          {deactivating ? "Deactivate" : "Reactivate"}
        </Action>
      </div>
    </li>
  );
}

const ROLES: Role[] = ["member", "admin", "owner"];

/**
 * Why a role control is unavailable, in the words the person needs.
 *
 * These mirror `enforce_membership_role`, which refuses all three cases with
 * errcode 42501 -- but the trigger is the backstop, not the affordance. A
 * button that is always going to fail is a worse screen than one that says why
 * before it is pressed, and `Action` uses aria-disabled precisely so a keyboard
 * or hovering user can still reach this sentence.
 */
function roleReason({
  member,
  target,
  iAmOwner,
}: {
  member: OrgMember;
  target: Role;
  iAmOwner: boolean;
}): string | null {
  if (member.isMe) return "You cannot change your own role. Ask another admin or the owner.";
  if (iAmOwner) return null;
  // Unreachable from the row above, which no longer offers `owner` to a
  // non-owner. Kept because this function is where the trigger's rules are
  // written down, and the filter is an affordance, not the enforcement.
  if (target === "owner") return "Only an owner can appoint another owner.";
  if (member.role === "owner") return "Only an owner can stand down an owner.";
  return null;
}

function statusReason({
  member,
  iAmOwner,
}: {
  member: OrgMember;
  iAmOwner: boolean;
}): string | null {
  // Not a database rule, which is the problem: nothing stops you deactivating
  // yourself, and it locks you out of the office in one tap with no way back.
  if (member.isMe) return "You cannot deactivate yourself. Ask another admin.";
  // my_org_ids() filters on status, so deactivating an owner is demotion by
  // another name, and enforce_membership_role treats it as one.
  if (member.role === "owner" && !iAmOwner) {
    return member.status === "active"
      ? "Only an owner can deactivate an owner."
      : "Only an owner can reactivate an owner.";
  }
  return null;
}

function withArticle(role: Role): string {
  return role === "member" ? `a ${role}` : `an ${role}`;
}

/**
 * The link an invitation actually needs.
 *
 * Nothing emails these. Until something does, an invitation that an admin
 * cannot hand to anybody is a row in a table and no more -- which is exactly
 * what it was: the token was fetched, never shown, and the invited person was
 * told nothing and became nothing.
 */
export function invitationLink(token: string): string {
  return `${window.location.origin}${window.location.pathname}#/join/${token}`;
}

/* -------------------------------------------------------------------- bits */

async function copyToClipboard(text: string): Promise<string> {
  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText !== "function") {
    throw new Error(
      "This browser will not let the page copy. Select the code and copy it by hand.",
    );
  }
  await clipboard.writeText(text);
  return text;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "3 days ago", or a plain date once relative stops being useful.
 *
 * A future timestamp lands in the first branch and reads "just now", which is
 * what a slightly fast clock deserves: the stamp is written by whichever
 * browser did the rotating, so a few seconds of skew is ordinary and not worth
 * showing anybody a negative age over.
 */
function sinceLabel(iso: string, now: Date, timeZone: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "at an unknown time";
  const ms = now.getTime() - then;
  if (ms < MINUTE) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });
  if (ms < HOUR) return rtf.format(-Math.floor(ms / MINUTE), "minute");
  if (ms < DAY) return rtf.format(-Math.floor(ms / HOUR), "hour");
  if (ms < 30 * DAY) return rtf.format(-Math.floor(ms / DAY), "day");
  return `on ${dateLabel(then, timeZone)}`;
}

/** The mirror of `sinceLabel`, for something that has not happened yet. */
function untilLabel(iso: string, now: Date, timeZone: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "at an unknown time";
  const ms = then - now.getTime();
  const rtf = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });
  if (ms < HOUR) return rtf.format(Math.max(1, Math.floor(ms / MINUTE)), "minute");
  if (ms < DAY) return rtf.format(Math.floor(ms / HOUR), "hour");
  if (ms < 30 * DAY) return rtf.format(Math.floor(ms / DAY), "day");
  return `on ${dateLabel(then, timeZone)}`;
}

function dateLabel(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(new Date(at));
}

/** The exact moment, in the office's own timezone, for the hover title. */
function absoluteLabel(iso: string, timeZone: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(at));
}

/** Shaped like the screen, so nothing jumps when the data lands. */
function PeopleSkeleton() {
  return (
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] lg:items-start">
      <div className="flex flex-col gap-6">
        <div className="rounded-lg border border-border bg-surface-raised p-4 md:p-6">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="mt-4 h-10 w-64" />
          <Skeleton className="mt-3 h-4 w-40" />
          <div className="mt-4 flex gap-2">
            <Skeleton className="h-11 w-24" />
            <Skeleton className="h-11 w-24" />
          </div>
        </div>
        <div>
          <Skeleton className="h-5 w-36" />
          <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-4">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        </div>
      </div>

      <div>
        <Skeleton className="h-5 w-36" />
        <div className="mt-3 flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      </div>

      <div className="lg:col-span-2">
        <Skeleton className="h-5 w-24" />
        <div className="mt-3 flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
