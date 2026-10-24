import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  createTag,
  listTags,
  setCustomerTags,
  TAG_COLOURS,
  TAG_TONE,
  type Tag,
  type TagColour,
  type TagRef,
} from '../crm-api';
import { Button, ErrorNotice, Pill, SelectField, TextField } from './ui';

/** Tag chips (ADR 0034). Colours map to the existing accessible pill tones. */
export function TagChips({ tags, label }: { tags?: TagRef[]; label?: string }) {
  if (!tags?.length) return null;
  return (
    <ul className="tag-list" aria-label={label ?? 'Tags'}>
      {tags.map((tag) => (
        <li key={tag.id}>
          <Pill tone={TAG_TONE[tag.colour] ?? 'neutral'}>{tag.name}</Pill>
        </li>
      ))}
    </ul>
  );
}

/** All tags for a picker or filter; reloads when `version` changes. */
export function useTags(version = 0) {
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    listTags()
      .then((result) => live && setTags(result.tags))
      .catch((caught: unknown) => live && setError(caught));
    return () => {
      live = false;
    };
  }, [version]);
  return { tags, error };
}

/** Owner tag editor: tick tags to assign, or create one inline. */
export function TagEditor({
  customerId,
  current,
  onSaved,
}: {
  customerId: string;
  current: TagRef[];
  onSaved: () => Promise<void> | void;
}) {
  const [version, setVersion] = useState(0);
  const { tags, error: loadError } = useTags(version);
  const [selected, setSelected] = useState(() => new Set(current.map((tag) => tag.id)));
  const [name, setName] = useState('');
  const [colour, setColour] = useState<TagColour>('slate');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(ids: Set<string>) {
    setBusy(true);
    setError(null);
    try {
      await setCustomerTags(customerId, [...ids]);
      await onSaved();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const existing = tags?.find((tag) => tag.name === name.trim().toLocaleLowerCase('en-NZ'));
      const tag = existing ?? (await createTag(name, colour));
      const next = new Set(selected).add(tag.id);
      setSelected(next);
      setName('');
      setVersion((value) => value + 1);
      await setCustomerTags(customerId, [...next]);
      await onSaved();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {(error !== null || loadError !== null) && (
        <ErrorNotice title="Tags not saved" error={error ?? loadError} />
      )}
      <fieldset className="tag-picker">
        <legend>Tags</legend>
        {tags?.length ? (
          tags.map((tag) => (
            <label key={tag.id} className="tag-option">
              <input
                type="checkbox"
                checked={selected.has(tag.id)}
                disabled={busy}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(tag.id);
                  else next.delete(tag.id);
                  setSelected(next);
                  void save(next);
                }}
              />
              <Pill tone={TAG_TONE[tag.colour] ?? 'neutral'}>{tag.name}</Pill>
            </label>
          ))
        ) : (
          <p className="hint">{tags ? 'No tags yet. Create one below.' : 'Loading tags…'}</p>
        )}
      </fieldset>
      <form className="tag-create" onSubmit={create}>
        <TextField
          label="New tag"
          value={name}
          maxLength={40}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
        />
        <SelectField
          label="Colour"
          value={colour}
          onChange={(event) => setColour(event.target.value as TagColour)}
        >
          {TAG_COLOURS.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </SelectField>
        <Button type="submit" icon="plus" disabled={busy || !name.trim()}>
          Add tag
        </Button>
      </form>
    </div>
  );
}
