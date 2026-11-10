import { useState, type ComponentProps, type MouseEvent } from "react";
import { ShellNav, type NavGroup } from "@evinvest/uikit";

function PageIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 3h9l3 3v15H6zM9 12h6M9 16h6" />
    </svg>
  );
}

const GROUPS: NavGroup[] = [
  {
    id: "getting-started",
    label: "Getting Started",
    collapsible: true,
    items: [
      { id: "installation", href: "/docs/installation", label: "Installation", icon: PageIcon },
      { id: "structure", href: "/docs/project-structure", label: "Project Structure", icon: PageIcon },
      { id: "layouts", href: "/docs/layouts-and-pages", label: "Layouts and Pages", icon: PageIcon },
      { id: "linking", href: "/docs/linking-and-navigating", label: "Linking and Navigating", icon: PageIcon },
      { id: "server-client", href: "/docs/server-and-client", label: "Server and Client Components", icon: PageIcon },
    ],
  },
  {
    id: "guides",
    label: "Guides",
    collapsible: true,
    items: [
      { id: "auth", href: "/guides/authentication", label: "Authentication", icon: PageIcon },
      { id: "caching", href: "/guides/caching", label: "Caching", icon: PageIcon },
      { id: "forms", href: "/guides/forms", label: "Forms", icon: PageIcon },
    ],
  },
  {
    id: "architecture",
    label: "Architecture",
    collapsible: true,
    href: "/architecture",
    items: [
      { id: "accessibility", href: "/architecture/accessibility", label: "Accessibility", icon: PageIcon },
      { id: "fast-refresh", href: "/architecture/fast-refresh", label: "Fast Refresh", icon: PageIcon },
    ],
  },
];

/** The pattern with the Next.js docs copy; a local "router" so a click moves the current row. */
export function CollapsibleNavSpecimen() {
  const [pathname, setPathname] = useState("/docs/installation");
  const [Link] = useState(
    () =>
      function DemoLink({ href, onClick, ...props }: ComponentProps<"a">) {
        return (
          <a
            href={href}
            {...props}
            onClick={(e: MouseEvent<HTMLAnchorElement>) => {
              onClick?.(e);
              e.preventDefault();
              if (href) setPathname(href);
            }}
          />
        );
      },
  );
  return (
    <div className="h-[28rem] overflow-hidden rounded-lg border border-border">
      <ShellNav groups={GROUPS} pathname={pathname} linkComponent={Link} labels={{ primary: "Docs" }} />
    </div>
  );
}
