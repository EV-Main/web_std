import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider, I18nScope, useLocale, useT } from "../src/react/index";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const MESSAGES = {
  "Invest in the China+1 narrative": "Инвестируйте в нарратив «Китай+1»",
  "{n, plural, one {# role} other {# roles}}": "{n, plural, one {# вакансия} few {# вакансии} many {# вакансий}}",
};

function Probe() {
  const t = useT();
  const locale = useLocale();
  return (
    <span data-testid="out">
      {locale}:{t("Invest in the China+1 narrative")}:
      {t("{n, plural, one {# role} other {# roles}}", { n: 3 })}
    </span>
  );
}

describe("I18nProvider", () => {
  it("supplies locale and a bound translate function", () => {
    act(() => {
      root.render(
        <I18nProvider missing="warn" locale="ru" messages={MESSAGES}>
          <Probe />
        </I18nProvider>,
      );
    });
    expect(container.textContent).toBe(
      "ru:Инвестируйте в нарратив «Китай+1»:3 вакансии",
    );
  });

  it("reports an untranslated id through onMissing and renders the inline English", () => {
    const onMissing = vi.fn();
    function Missing() {
      return <span>{useT().ctx("hero", "Five hundred years of compounding")}</span>;
    }
    act(() => {
      root.render(
        <I18nProvider missing="warn" locale="ru" messages={MESSAGES} onMissing={onMissing}>
          <Missing />
        </I18nProvider>,
      );
    });
    expect(container.textContent).toBe("Five hundred years of compounding");
    expect(onMissing).toHaveBeenCalledWith("hero\u0004Five hundred years of compounding", "ru");
  });
});

describe("hooks without a provider", () => {
  it("throw a message pointing at the Server Component path", () => {
    // A missing provider means the locale itself is unknown — there is nothing
    // to degrade to, so this must fail loudly rather than render one locale
    // inside another.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => {
      act(() => {
        root.render(<Probe />);
      });
    }).toThrow(/requires an <I18nProvider>/);
    spy.mockRestore();
  });
});

/** Renders `locale|text` for one string, `k` being its English. */
function Key({ k }: { k: string }) {
  const t = useT();
  return (
    <i>
      {useLocale()}|{t(k)};
    </i>
  );
}

const SHELL = { a: "ru-a", b: "ru-b-shell" };
const ROUTE = { b: "ru-b-route", c: "ru-c" };

/** Silences React's own report of a render error the test expects. */
const quietReactErrors = () => vi.spyOn(console, "error").mockImplementation(() => {});

describe("I18nScope", () => {
  it("lays its messages over the provider's and takes the provider's locale", () => {
    act(() => {
      root.render(
        <I18nProvider missing="warn" locale="ru" messages={SHELL}>
          <I18nScope messages={ROUTE}>
            <Key k="a" />
            <Key k="b" />
            <Key k="c" />
          </I18nScope>
        </I18nProvider>,
      );
    });

    expect(container.textContent).toBe("ru|ru-a;ru|ru-b-route;ru|ru-c;");
  });

  it("widens only its own subtree", () => {
    act(() => {
      root.render(
        <I18nProvider missing="warn" locale="ru" messages={SHELL}>
          <I18nScope messages={ROUTE}>
            <Key k="b" />
          </I18nScope>
          <Key k="b" />
          <Key k="c" />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toBe("ru|ru-b-route;ru|ru-b-shell;ru|c;");
  });

  it("lets the nearest of nested scopes win an id both carry", () => {
    act(() => {
      root.render(
        <I18nProvider missing="warn" locale="ru" messages={SHELL}>
          <I18nScope messages={ROUTE}>
            <I18nScope messages={{ c: "ru-c-inner" }}>
              <Key k="b" />
              <Key k="c" />
            </I18nScope>
          </I18nScope>
        </I18nProvider>,
      );
    });

    expect(container.textContent).toBe("ru|ru-b-route;ru|ru-c-inner;");
  });

  it("renders the call site's English under the default locale", () => {
    act(() => {
      root.render(
        <I18nProvider missing="warn" locale="en" messages={{}}>
          <I18nScope messages={ROUTE}>
            <Key k="c" />
          </I18nScope>
        </I18nProvider>,
      );
    });

    expect(container.textContent).toBe("en|c;");
  });

  it("throws without a provider above it", () => {
    quietReactErrors();

    expect(() => {
      act(() => {
        root.render(
          <I18nScope messages={ROUTE}>
            <Key k="c" />
          </I18nScope>,
        );
      });
    }).toThrow(/<I18nScope> requires an <I18nProvider>/);
  });

  it("passes an id neither carries to the provider's onMissing", () => {
    const onMissing = vi.fn();
    act(() => {
      root.render(
        <I18nProvider missing="warn" locale="ru" messages={SHELL} onMissing={onMissing}>
          <I18nScope messages={ROUTE}>
            <Key k="gone" />
          </I18nScope>
        </I18nProvider>,
      );
    });

    expect(container.textContent).toBe("ru|gone;");
    expect(onMissing).toHaveBeenCalledWith("gone", "ru");
  });
});

describe("I18nProvider missing", () => {
  it('warns once per id with "warn", across scopes and re-renders', () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tree = () => (
      <I18nProvider locale="ru" messages={{}} missing="warn">
        <Key k="x" />
        <Key k="x" />
        <I18nScope messages={{}}>
          <Key k="x" />
          <Key k="y" />
        </I18nScope>
      </I18nProvider>
    );
    act(() => root.render(tree()));
    act(() => root.render(tree()));

    expect(container.textContent).toBe("ru|x;ru|x;ru|x;ru|y;");
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, expect.stringContaining('"x" has no ru translation'));
    expect(warn).toHaveBeenNthCalledWith(2, expect.stringContaining('"y" has no ru translation'));
  });

  it('warns once per id when every render passes a new inline onMissing with "warn"', () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tree = () => (
      <I18nProvider locale="ru" messages={{}} missing="warn" onMissing={() => {}}>
        <Key k="x" />
      </I18nProvider>
    );
    act(() => root.render(tree()));
    act(() => root.render(tree()));
    act(() => root.render(tree()));

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("reports each miss to the onMissing passed by the latest render", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = vi.fn();
    const second = vi.fn();
    const tree = (onMissing: (key: string) => void, k: string) => (
      <I18nProvider locale="ru" messages={{}} missing="warn" onMissing={onMissing}>
        <Key k={k} />
      </I18nProvider>
    );
    act(() => root.render(tree(first, "x")));
    act(() => root.render(tree(second, "y")));

    expect(first.mock.calls).toEqual([["x", "ru"]]);
    expect(second.mock.calls).toEqual([["y", "ru"]]);
  });

  it('still calls onMissing for every miss with "warn"', () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const onMissing = vi.fn();
    act(() => {
      root.render(
        <I18nProvider locale="ru" messages={{}} missing="warn" onMissing={onMissing}>
          <Key k="x" />
          <Key k="x" />
        </I18nProvider>,
      );
    });

    expect(onMissing).toHaveBeenCalledTimes(2);
  });

  it('fails the render with "throw", naming the id, the check and the slice generator', () => {
    quietReactErrors();

    expect(() => {
      act(() => {
        root.render(
          <I18nProvider locale="ru" messages={{}} missing="throw">
            <I18nScope messages={{}}>
              <Key k="z" />
            </I18nScope>
          </I18nProvider>,
        );
      });
    }).toThrow(/"z" has no ru translation.*evinvest-i18n-check.*evinvest-i18n-slices/);
  });

  it("neither warns nor throws under the default locale", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    act(() => {
      root.render(
        <>
          <I18nProvider locale="en" messages={{}} missing="throw">
            <Key k="z" />
          </I18nProvider>
          <I18nProvider locale="en" messages={{}} missing="warn">
            <Key k="z" />
          </I18nProvider>
        </>,
      );
    });

    expect(container.textContent).toBe("en|z;en|z;");
    expect(warn).not.toHaveBeenCalled();
  });
});
