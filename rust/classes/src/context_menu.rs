use crate::focus::option_focus_ring;

pub const CONTEXT_MENU_CONTENT: &str = "bg-popover text-ink \
                       z-50 min-w-[8rem] \
                       overflow-x-hidden overflow-y-auto rounded-panel \
                       border border-border p-1 shadow-md";
pub const CONTEXT_MENU_SUB_CONTENT: &str = "bg-popover text-ink \
                           z-50 min-w-[8rem] \
                           overflow-hidden rounded-panel border border-border p-1 shadow-lg";
pub const CONTEXT_MENU_ITEM: &str = concat!(
	"focus:bg-hover focus:text-ink ",
	option_focus_ring!(),
	" data-[variant=destructive]:text-accent-error \
                    data-[variant=destructive]:focus:bg-accent-error/(--tint-hover) data-[variant=destructive]:focus:text-accent-error \
                    data-[variant=destructive]:*:[svg]:!text-accent-error [&_svg:not([class*='text-'])]:text-ink-soft \
                    relative flex cursor-default items-center gap-2 rounded-row px-2 min-h-(--control-h-sm) text-sm outline-hidden select-none \
                    data-[disabled]:pointer-events-none data-[disabled]:opacity-(--disabled-opacity) data-[inset]:pl-8 [&_svg]:pointer-events-none \
                    [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
);
pub const CONTEXT_MENU_CHECK_ITEM: &str = concat!(
	"focus:bg-hover focus:text-ink ",
	option_focus_ring!(),
	" relative flex cursor-default items-center gap-2 rounded-row \
                          min-h-(--control-h-sm) pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none \
                          data-[disabled]:opacity-(--disabled-opacity) [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
);
pub const CONTEXT_MENU_SUB_TRIGGER: &str = concat!(
	"focus:bg-hover focus:text-ink ",
	option_focus_ring!(),
	" data-[state=open]:bg-hover \
                           data-[state=open]:text-ink [&_svg:not([class*='text-'])]:text-ink-soft flex \
                           cursor-default items-center rounded-row px-2 min-h-(--control-h-sm) text-sm outline-hidden select-none \
                           data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
);
pub const CONTEXT_MENU_LABEL: &str = "text-ink px-2 py-1.5 text-sm font-medium data-[inset]:pl-8";
pub const CONTEXT_MENU_SEPARATOR: &str = "bg-border -mx-1 my-1 h-px";
pub const CONTEXT_MENU_SHORTCUT: &str = "text-ink-soft ml-auto text-xs tracking-widest";
pub const CONTEXT_MENU_ITEM_INDICATOR: &str = "pointer-events-none absolute left-2 flex size-3.5 items-center justify-center";
