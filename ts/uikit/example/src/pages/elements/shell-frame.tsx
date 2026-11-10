import { useEffect, useState, type ComponentProps, type ElementType, type MouseEvent } from "react";
import {
  AccountMenu,
  AppShell,
  BottomTabBar,
  Button,
  Card,
  CardContent,
  IconButton,
  Input,
  CardHeader,
  CardTitle,
  MobileAppBar,
  NavigationMenu,
  NavigationMenuList,
  NavMenu,
  NavMenuList,
  NavDot,
  PageFrame,
  ResourceError,
  SectionNav,
  Settled,
  ShellNav,
  Skeleton,
  SystemBanner,
  TopBar,
  type NavGroup,
  type NavItem,
  type NavSection,
} from "@evinvest/uikit";

// A stand-in for a router: the demo keeps its "URL" in state, and the link
// reports the click upward the way next/link hands it to the router. The delay
// is the server round-trip during which the rail's optimistic mark shows.
function useFakeRouter() {
  const [pathname, setPathname] = useState("/");
  // Held in state so the component type is stable across renders — a fresh one
  // each render would remount every link (and drop focus) on each click.
  const [Link] = useState(
    () =>
      function DemoLink({ href, onClick, ...props }: ComponentProps<"a">) {
        return (
          <a
            href={href}
            {...props}
            onClick={(e: MouseEvent<HTMLAnchorElement>) => {
              onClick?.(e);
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              if (href) setTimeout(() => setPathname(href), 250);
            }}
          />
        );
      },
  );
  return { pathname, Link };
}

const glyph = (d: string) =>
  function Glyph({ className }: { className?: string }) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d={d} />
      </svg>
    );
  };
const HomeIcon = glyph("M3 10.5 12 3l9 7.5V21H3z");
const ChartIcon = glyph("M3 3v18h18M7 15l4-4 3 3 5-6");
const WalletIcon = glyph("M3 7h18v12H3zM16 13h2");
const UsersIcon = glyph("M16 21v-2a4 4 0 0 0-8 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z");
const BellIcon = glyph("M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4");
const CogIcon = glyph("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z");
const FilterIcon = glyph("M3 5h18l-7 8v6l-4 2v-8z");
const RailIcon = glyph("M3 4h18v16H3zM9 4v16");
const UserIcon = glyph("M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z");

const GROUPS: NavSection[] = [
  {
    id: "fund",
    label: "Your account",
    items: [
      { id: "home", href: "/", label: "Home", description: "Balances at a glance", icon: HomeIcon },
      { id: "invest", href: "/invest", label: "Invest", description: "Products open to you", icon: ChartIcon },
      { id: "wallet", href: "/wallet", label: "Wallet", description: "Deposits and withdrawals", icon: WalletIcon },
    ],
  },
  {
    id: "admin",
    label: "Administer",
    items: [
      { id: "users", href: "/admin/users", label: "Users", description: "Everyone with an account", icon: UsersIcon },
      { id: "soon", href: "/admin/soon", label: "Coming soon", description: "Not open yet", icon: CogIcon, disabled: true },
    ],
  },
  {
    id: "filters",
    label: "Filters",
    icon: FilterIcon,
    content: (
      <div className="flex flex-col gap-2 pl-1">
        <p className="text-xs font-semibold uppercase tracking-widest text-ink-soft">Filters</p>
        <Input size="sm" placeholder="Search accounts" aria-label="Search accounts" />
      </div>
    ),
  },
];

// Another app's nav, as a `menu` panel: folded, its icon's flyout is this list.
const reports = (pathname: string, Link: ElementType): NavSection => ({
  id: "reports",
  label: "Reports",
  icon: ChartIcon,
  menu: true,
  content: (
    <NavMenuList
      groups={[
        {
          id: "reports",
          items: [
            { id: "monthly", href: "/reports/monthly", label: "Monthly", description: "Each month's statement", icon: ChartIcon },
            { id: "tax", href: "/reports/tax", label: "Tax", description: "What to declare", icon: WalletIcon },
          ],
        },
      ]}
      pathname={pathname}
      linkComponent={Link}
    />
  ),
});

const FOOTER: NavSection[] = [
  {
    id: "me",
    items: [
      { id: "profile", href: "/profile", label: "Profile", description: "Who you are to us", icon: UserIcon, trailing: <NavDot tone="warn" label="Verification pending" /> },
      { id: "inbox", href: "/notifications", label: "Notifications", description: "What happened while you were away", icon: BellIcon, badge: 128 },
      { id: "settings", href: "/settings", label: "Settings", description: "Preferences and security", icon: CogIcon },
    ],
  },
];

const TABS: NavItem[] = [
  { id: "home", href: "/", label: "Home", description: "Balances at a glance", icon: HomeIcon },
  { id: "invest", href: "/invest", label: "Invest", description: "Products open to you", icon: ChartIcon },
  { id: "wallet", href: "/wallet", label: "Wallet", description: "Deposits and withdrawals", icon: WalletIcon },
  { id: "account", href: "/settings", label: "Account", description: "Who you are and how you sign in", icon: UserIcon, also: ["/profile", "/notifications"], badge: 128 },
];

function DemoPage({ pathname }: { pathname: string }) {
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState("general");
  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => setLoading(false), 700);
    return () => clearTimeout(t);
  }, [pathname]);
  return (
    <PageFrame
      key={pathname}
      title={pathname === "/" ? "Home" : pathname}
      description="Sections arrive in sequence by CSS alone."
      appBar={<MobileAppBar title={pathname} hideFrom="lg" />}
      actions={<Button variant="outline" size="sm">Export</Button>}
    >
      <Card>
        <CardHeader>
          <CardTitle>Balance</CardTitle>
        </CardHeader>
        <CardContent>
          <Settled loading={loading} skeleton={<Skeleton className="h-8 w-40" />}>
            <p className="font-serif text-figure-l text-ink font-light tabular-nums">12 480.00</p>
          </Settled>
        </CardContent>
      </Card>
      <ResourceError message="Couldn't load the activity feed." onRetry={() => setLoading(true)} />
      <div className="flex gap-6">
        <SectionNav
          className="hidden md:flex"
          value={section}
          onValueChange={setSection}
          groups={[
            { id: "app", label: "Cabinet", description: "How the app behaves", items: [{ id: "general", label: "General" }, { id: "alerts", label: "Alerts" }] },
            { id: "you", label: "Profile", items: [{ id: "personal", label: "Personal" }] },
          ]}
        />
        <Card className="flex-1">
          <CardContent className="text-ink-soft pt-6 text-body">Pane: {section}</CardContent>
        </Card>
      </div>
    </PageFrame>
  );
}

export function ShellFrame() {
  const { pathname, Link } = useFakeRouter();
  const [announce, setAnnounce] = useState(true);
  const [folded, setFolded] = useState(false);
  return (
    // `transform` makes this box the containing block of the shell's `fixed` tab
    // bar, so the demo stays inside its frame instead of covering the page; one
    // viewport tall because the rail is.
    <div className="border-border h-dvh overflow-auto rounded-lg border [transform:translateZ(0)]">
      <AppShell
        className="min-h-full"
        rail={<ShellNav groups={[...GROUPS, reports(pathname, Link)]} footerGroups={FOOTER} pathname={pathname} linkComponent={Link} folded={folded} />}
        tabBar={<BottomTabBar items={TABS} pathname={pathname} linkComponent={Link} />}
        topBar={
          <TopBar
            start={
              <>
                <IconButton aria-label="Fold the rail" tooltip="Fold the rail" pressed={folded} onClick={() => setFolded(!folded)}>
                  <RailIcon className="size-4" />
                </IconButton>
                <span className="text-ink font-semibold">ACME</span>
              </>
            }
            end={
              <>
                <span className="text-ink-soft text-body">123 tokens</span>
                <AccountMenu
                  account={{ name: "Ada Lovelace", email: "ada@example.com" }}
                  manageHref="#account-center"
                  switchHref="#switch-account"
                  groups={[{ id: "service", items: [{ id: "account", href: "/profile", label: "Account", description: "Who you are and how you sign in", icon: UserIcon }] }]}
                  onSignOut={() => {}}
                  linkComponent={Link}
                />
              </>
            }
          />
        }
        banner={
          <>
            <SystemBanner tone="warn">Read-only: withdrawals are paused.</SystemBanner>
            {announce && (
              <SystemBanner title="Scheduled maintenance" onDismiss={() => setAnnounce(false)}>
                Sunday 02:00–03:00 UTC.
              </SystemBanner>
            )}
          </>
        }
      >
        <DemoPage pathname={pathname} />
      </AppShell>
    </div>
  );
}

/** The rail's groups in a top bar's menus: hover or focus opens one, the rows carry their descriptions. */
export function NavMenuSpecimen() {
  const groups = GROUPS.filter((s): s is NavGroup => "items" in s);
  return (
    <NavigationMenu viewport={false}>
      <NavigationMenuList>
        <NavMenu label="Account" href="#/elements/navigation" current>
          <NavMenuList groups={groups} pathname="/invest" />
        </NavMenu>
        <NavMenu label="Docs" href="#/elements/navigation" current={false} />
      </NavigationMenuList>
    </NavigationMenu>
  );
}
