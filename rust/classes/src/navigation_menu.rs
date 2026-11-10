pub const NAVIGATION_MENU: &str = "group/navigation-menu relative flex max-w-max flex-1 items-center justify-center";

pub const NAVIGATION_MENU_LIST: &str = "group flex flex-1 list-none items-center justify-center gap-1";

pub const NAVIGATION_MENU_ITEM: &str = "relative";

pub const NAVIGATION_MENU_TRIGGER_STYLE: &str = "group inline-flex h-(--control-h-md) w-max items-center justify-center rounded-control bg-transparent px-4 py-2 \
                             text-sm font-medium hover:bg-hover hover:text-ink focus:bg-hover \
                             focus:text-ink disabled:pointer-events-none disabled:opacity-(--disabled-opacity) \
                             data-[state=open]:text-ink \
                             data-[state=open]:bg-hover focus-visible:ring-ring/50 \
                             outline-none transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:outline-1";

pub const NAVIGATION_MENU_CONTENT: &str = "absolute top-full left-0 z-50 mt-1.5 w-max max-w-[calc(100vw-2rem)] \
                       before:absolute before:inset-x-0 before:-top-2 before:h-2 \
                       rounded-panel border border-border bg-popover p-2 pr-2.5 text-ink shadow \
                       **:data-[slot=navigation-menu-link]:focus:ring-0 \
                       **:data-[slot=navigation-menu-link]:focus:outline-none";

pub const NAVIGATION_MENU_LINK: &str = "data-[active=true]:bg-selected \
                    data-[active=true]:text-ink hover:bg-hover hover:text-ink \
                    focus:bg-hover focus:text-ink focus-visible:ring-ring/50 \
                    [&_svg:not([class*='text-'])]:text-ink-soft flex flex-col gap-1 rounded-row p-2 text-sm \
                    transition-all outline-none focus-visible:ring-[3px] focus-visible:outline-1 \
                    [&_svg:not([class*='size-'])]:size-4";

pub const NAVIGATION_MENU_INDICATOR: &str = "top-full z-[1] flex h-1.5 items-end justify-center overflow-hidden";

pub const NAVIGATION_MENU_VIEWPORT: &str = "bg-popover text-ink \
                              relative mt-1.5 h-[var(--radix-navigation-menu-viewport-height)] w-full overflow-hidden \
                              rounded-panel border border-border shadow md:w-[var(--radix-navigation-menu-viewport-width)]";
pub const NAVIGATION_MENU_TRIGGER_CHEVRON: &str = "relative top-[1px] ml-1 size-3 group-data-[state=open]:rotate-180";
pub const NAVIGATION_MENU_VIEWPORT_WRAPPER: &str = "absolute top-full left-0 isolate z-50 flex justify-center";
pub const NAVIGATION_MENU_INDICATOR_ARROW: &str = "bg-border relative top-[60%] h-2 w-2 rotate-45 rounded-tl-sm shadow-md";
