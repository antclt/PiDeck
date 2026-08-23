import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useMemo,
  type ComponentPropsWithoutRef,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { cn } from "@/lib/utils";

/**
 * Local layout contract for cards that live above the session composer.
 *
 * A disclosure change must re-render ComposerMeasuredExtras itself so its
 * layout effect can resize the controlled panel before Chromium paints. Keeping
 * this state in individual cards would leave ResizeObserver as the first
 * responder and makes the panel trail the content change.
 */
export type ComposerWidgetCollapsedByKey = Readonly<Record<string, boolean>>;

export function resolveComposerWidgetCollapsed(
  collapsedByKey: ComposerWidgetCollapsedByKey,
  key: string,
  defaultCollapsed: boolean,
): boolean {
  return collapsedByKey[key] ?? defaultCollapsed;
}

export function toggleComposerWidgetCollapsed(
  collapsedByKey: ComposerWidgetCollapsedByKey,
  key: string,
  defaultCollapsed: boolean,
): Record<string, boolean> {
  return {
    ...collapsedByKey,
    [key]: !resolveComposerWidgetCollapsed(collapsedByKey, key, defaultCollapsed),
  };
}

type ComposerWidgetLayoutValue = {
  collapsedByKey: ComposerWidgetCollapsedByKey;
  setCollapsed: (key: string, collapsed: boolean) => void;
  toggleCollapsed: (key: string, defaultCollapsed: boolean) => void;
};

const ComposerWidgetLayoutContext = createContext<ComposerWidgetLayoutValue | null>(null);

export function ComposerWidgetLayoutProvider(props: {
  value: ComposerWidgetLayoutValue;
  children: ReactNode;
}) {
  return (
    <ComposerWidgetLayoutContext.Provider value={props.value}>
      {props.children}
    </ComposerWidgetLayoutContext.Provider>
  );
}

/** Returns the controlled collapse state for a session-scoped widget identity. */
export function useComposerWidgetCollapsed(key: string, defaultCollapsed = true) {
  const layout = useContext(ComposerWidgetLayoutContext);
  if (!layout) {
    throw new Error("useComposerWidgetCollapsed must be used under ComposerWidgetLayoutProvider");
  }

  const collapsed = resolveComposerWidgetCollapsed(
    layout.collapsedByKey,
    key,
    defaultCollapsed,
  );
  const setCollapsed = useCallback(
    (next: boolean) => layout.setCollapsed(key, next),
    [key, layout],
  );
  const toggleCollapsed = useCallback(
    () => layout.toggleCollapsed(key, defaultCollapsed),
    [defaultCollapsed, key, layout],
  );

  return { collapsed, setCollapsed, toggleCollapsed };
}

/** Shared visual frame for all cards placed in the composer widget scrollport. */
export const ComposerWidgetFrame = forwardRef<HTMLElement, ComponentPropsWithoutRef<"section">>(
  function ComposerWidgetFrame({ className, ...props }, ref) {
    return (
      <section
        ref={ref}
        {...props}
        className={cn(
          "w-full shrink-0 overflow-hidden rounded-xl border border-border bg-card",
          className,
        )}
      />
    );
  },
);

/** Builds the stable context value owned by ComposerMeasuredExtras. */
export function useComposerWidgetLayoutValue(
  collapsedByKey: ComposerWidgetCollapsedByKey,
  setCollapsedByKey: Dispatch<SetStateAction<Record<string, boolean>>>,
): ComposerWidgetLayoutValue {
  const setCollapsed = useCallback((key: string, collapsed: boolean) => {
    setCollapsedByKey((current) => {
      if (current[key] === collapsed) return current;
      return { ...current, [key]: collapsed };
    });
  }, [setCollapsedByKey]);
  const toggleCollapsed = useCallback((key: string, defaultCollapsed: boolean) => {
    setCollapsedByKey((current) =>
      toggleComposerWidgetCollapsed(current, key, defaultCollapsed),
    );
  }, [setCollapsedByKey]);

  return useMemo(
    () => ({ collapsedByKey, setCollapsed, toggleCollapsed }),
    [collapsedByKey, setCollapsed, toggleCollapsed],
  );
}
