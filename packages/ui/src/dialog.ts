import { defineComponent, h, inject, provide, type InjectionKey, type PropType } from 'vue';
import { DialogContent, DialogDescription, DialogOverlay, DialogRoot, DialogTitle } from 'reka-ui';
import './dialog.css';

// Reka calls Object.hasOwn (Chrome 93) every time a dialog opens, and the app
// runs from WebView 92: without this, every dialog - the till lock among them -
// would throw on exactly the oldest devices the app supports.
if (typeof Object.hasOwn !== 'function') {
  Object.defineProperty(Object, 'hasOwn', {
    configurable: true,
    writable: true,
    value: (object: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(object, key),
  });
}

/**
 * The behaviour every modal dialog shares, with no looks of its own: focus
 * moves in and stays in, Escape closes it wherever focus is, the page behind
 * does not scroll, and closing hands focus back to whatever opened it.
 *
 * The behaviour is Reka UI's Dialog; it stays hidden behind these four parts,
 * so nothing outside this package imports it. Each part adds its behaviour
 * to the one element written inside it and renders nothing itself - the
 * dialog's markup, classes and scoped styles stay with the component that
 * wrote them:
 *
 *   <DialogLayer @close="emit('close')">
 *     <div class="backdrop">
 *       <DialogPanel>
 *         <div class="card" tabindex="-1">
 *           <DialogHeading><h2>Title</h2></DialogHeading>
 *           …
 *
 * Nothing is teleported: a dialog stays where it is written, so the page's
 * own styles (`.page .hint`, a module's scoped rules) still reach inside it.
 *
 * A dialog exists while it is mounted; the owner opens it with `v-if` and
 * closes it on `close`. Dialogs stack (a confirmation over an editor, the
 * till lock over both) and only the top one answers keys.
 */

const DISMISSABLE: InjectionKey<() => boolean> = Symbol('zfy-dialog-dismissable');

/**
 * Wraps the backdrop element. `close` is asked for by Escape and by a press
 * on the backdrop; with `dismissable` off neither does anything (the till
 * lock), and the dialog only ever goes when its owner unmounts it.
 */
export const DialogLayer = defineComponent({
  name: 'DialogLayer',
  props: { dismissable: { type: Boolean, default: true } },
  emits: { close: () => true },
  setup(props, { emit, slots }) {
    provide(DISMISSABLE, () => props.dismissable);
    const close = (): void => {
      if (props.dismissable) emit('close');
    };

    // Closes only when press and release both land on the backdrop, so a
    // text-selection drag that ends outside a field does not dismiss the
    // dialog. Closing on `click` rather than `pointerup` keeps the overlay
    // mounted for the follow-up click, so on touch the tap is absorbed
    // instead of landing on whatever is behind.
    let pressedOnBackdrop = false;
    const onPointerdown = (e: PointerEvent): void => {
      pressedOnBackdrop = e.target === e.currentTarget;
    };
    const onClick = (e: MouseEvent): void => {
      if (pressedOnBackdrop && e.target === e.currentTarget) close();
      pressedOnBackdrop = false;
    };

    // Always open: the owner's v-if is the switch. Reka asking to close is
    // passed on as a request, never acted on here.
    const onOpenChange = (open: boolean): void => {
      if (!open) close();
    };
    return () =>
      h(DialogRoot, { open: true, 'onUpdate:open': onOpenChange }, () =>
        h(DialogOverlay, { asChild: true, onPointerdown, onClick }, () => slots.default?.()),
      );
  },
});

/**
 * Wraps the dialog's own box, which needs `tabindex="-1"` to take focus when
 * it holds nothing focusable. Focus opens on `initialFocus`'s pick, or on the
 * box itself.
 */
export const DialogPanel = defineComponent({
  name: 'DialogPanel',
  props: {
    initialFocus: { type: Function as PropType<(panel: HTMLElement) => HTMLElement | null | undefined>, default: undefined },
    /** Set when a DialogSummary inside describes the dialog. */
    described: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    const dismissable = inject(DISMISSABLE, () => true);

    const onOpenAutoFocus = (e: Event): void => {
      const panel = e.currentTarget as HTMLElement | null;
      if (!panel) return;
      e.preventDefault();
      (props.initialFocus?.(panel) ?? panel).focus();
    };
    // A press or focus outside is not a reason to close: the backdrop decides
    // presses itself (DialogLayer), and focus leaves for a dialog opened on top.
    const keepOpen = (e: Event): void => e.preventDefault();
    const onEscapeKeyDown = (e: Event): void => {
      if (!dismissable()) e.preventDefault();
    };

    return () =>
      h(
        DialogContent,
        {
          asChild: true,
          onOpenAutoFocus,
          onInteractOutside: keepOpen,
          onEscapeKeyDown,
          // Reka points aria-describedby at a description unless told there is none.
          ...(props.described ? {} : { 'aria-describedby': undefined }),
        },
        () => slots.default?.(),
      );
  },
});

/** Wraps the heading that names the dialog to a screen reader. */
export const DialogHeading = defineComponent({
  name: 'DialogHeading',
  setup: (_, { slots }) => () => h(DialogTitle, { asChild: true }, () => slots.default?.()),
});

/** Wraps the sentence that says what the dialog asks; pair with `described` on the panel. */
export const DialogSummary = defineComponent({
  name: 'DialogSummary',
  setup: (_, { slots }) => () => h(DialogDescription, { asChild: true }, () => slots.default?.()),
});
