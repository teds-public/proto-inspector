/**
 * Turns a native `<select>` into a searchable dropdown.
 *
 * The `<select>` stays the source of truth: its value, `change` events and
 * `select.value = ...` keep working exactly as before, so callers do not have
 * to know this exists. A text input and a filtered list are layered on top.
 *
 * Native selects are left alone when they are short: a search field over four
 * options is more friction than it saves.
 */

const MIN_OPTIONS_TO_SEARCH = 8;

export interface SearchableSelectOptions {
  /** Called after the value changes through this control. */
  readonly onCommit?: (value: string) => void;
  /** Force the feature on or off regardless of the option count. */
  readonly enabled?: boolean;
}

interface Attachment {
  detach(): void;
}

const attached = new WeakMap<HTMLSelectElement, Attachment>();

/** (Re)installs the searchable behaviour after the option list changed. */
export function refreshSearchableSelect(select: HTMLSelectElement): void {
  const existing = attached.get(select);
  if (existing) {
    existing.detach();
    attached.delete(select);
  }
  attachSearchableSelect(select);
}

export function attachSearchableSelect(
  select: HTMLSelectElement,
  options: SearchableSelectOptions = {},
): void {
  if (attached.has(select)) return;
  const shouldSearch =
    options.enabled ?? (select.options.length >= MIN_OPTIONS_TO_SEARCH && !select.multiple);
  if (!shouldSearch) return;

  // The native select stays in the DOM for value/state, but is not shown.
  select.classList.add("searchable-select__native");

  const wrapper = document.createElement("div");
  wrapper.className = "searchable-select";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "searchable-select__input";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");

  const list = document.createElement("ul");
  list.className = "searchable-select__list";
  list.setAttribute("role", "listbox");
  list.hidden = true;

  wrapper.append(input, list);
  select.insertAdjacentElement("afterend", wrapper);

  const optionLabel = (option: HTMLOptionElement): string => option.textContent ?? option.value;

  const syncInputFromValue = (): void => {
    const selected = select.options[select.selectedIndex];
    input.value = selected && selected.value !== "" ? optionLabel(selected) : "";
    input.placeholder = selected && selected.value === "" ? optionLabel(selected) : "Search…";
  };

  const close = (): void => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
  };

  const commit = (option: HTMLOptionElement): void => {
    if (select.value === option.value) {
      syncInputFromValue();
      close();
      return;
    }
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    syncInputFromValue();
    close();
    options.onCommit?.(option.value);
  };

  const open = (): void => {
    renderList("");
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };

  const renderList = (query: string): void => {
    const needle = query.trim().toLowerCase();
    list.replaceChildren();
    let shown = 0;
    for (const option of Array.from(select.options)) {
      const label = optionLabel(option);
      if (needle && !label.toLowerCase().includes(needle)) continue;
      const item = document.createElement("li");
      item.className = "searchable-select__option";
      item.setAttribute("role", "option");
      item.textContent = label;
      if (option.value === select.value) item.classList.add("is-selected");
      // mousedown, not click: the input would lose focus first and close the list.
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        commit(option);
      });
      list.append(item);
      shown++;
      if (shown >= 200) break;
    }
    if (shown === 0) {
      const empty = document.createElement("li");
      empty.className = "searchable-select__empty";
      empty.textContent = "No match";
      list.append(empty);
    }
  };

  const onFocus = (): void => {
    input.select();
    open();
  };
  const onInput = (): void => {
    if (list.hidden) open();
    else renderList(input.value);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      syncInputFromValue();
      close();
      input.blur();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const first = list.querySelector<HTMLLIElement>(".searchable-select__option");
      if (first) {
        const label = first.textContent ?? "";
        const option = Array.from(select.options).find((candidate) => optionLabel(candidate) === label);
        if (option) commit(option);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const first = list.querySelector<HTMLLIElement>(".searchable-select__option");
      first?.classList.add("is-focused");
    }
  };
  const onBlur = (): void => {
    // Let a mousedown on an option land before closing.
    window.setTimeout(() => {
      if (!wrapper.contains(document.activeElement)) {
        syncInputFromValue();
        close();
      }
    }, 120);
  };
  const onDocumentPointerDown = (event: PointerEvent): void => {
    if (!wrapper.contains(event.target as Node)) {
      syncInputFromValue();
      close();
    }
  };
  const onSelectChange = (): void => syncInputFromValue();

  input.addEventListener("focus", onFocus);
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeyDown);
  input.addEventListener("blur", onBlur);
  document.addEventListener("pointerdown", onDocumentPointerDown);
  select.addEventListener("change", onSelectChange);

  syncInputFromValue();

  attached.set(select, {
    detach() {
      input.removeEventListener("focus", onFocus);
      input.removeEventListener("input", onInput);
      input.removeEventListener("keydown", onKeyDown);
      input.removeEventListener("blur", onBlur);
      document.removeEventListener("pointerdown", onDocumentPointerDown);
      select.removeEventListener("change", onSelectChange);
      select.classList.remove("searchable-select__native");
      wrapper.remove();
    },
  });
}
