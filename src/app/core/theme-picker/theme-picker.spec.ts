import { TestBed } from '@angular/core/testing';
import { DB_API } from '../db-api';
import { fakeDbApi } from '../../testing/fake-db-api';
import { ThemeStore } from '../theme.store';
import { CUSTOM_THEMES_KEY, savedCustomThemes } from '../themes';
import { ThemePicker } from './theme-picker';

const THEME = JSON.stringify({
  name: 'Mosgroen',
  type: 'dark',
  colors: { 'editor.background': '#18211b', 'editor.foreground': '#d5e0d6' },
  tokenColors: [{ scope: 'keyword', settings: { foreground: '#9fd48a' } }],
});

async function setup() {
  Element.prototype.scrollIntoView ??= () => undefined;
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  localStorage.clear();
  TestBed.configureTestingModule({ providers: [{ provide: DB_API, useValue: fakeDbApi() }] });
  const fixture = TestBed.createComponent(ThemePicker);
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r));
    }
  };
  await settle();
  const choose = async (content: string, name = 'mosgroen-color-theme.json') => {
    const input = el.querySelector<HTMLInputElement>('input[type=file]')!;
    const file = new File([content], name, { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle();
  };
  return { el, settle, choose, store: TestBed.inject(ThemeStore) };
}

describe('ThemePicker import', () => {
  it('adds a VS Code theme, chooses it and keeps it', async () => {
    const { el, choose, store } = await setup();
    await choose(THEME);
    expect(store.choice()).toBe('vscode-mosgroen');
    expect(store.active().colors.bg).toBe('#18211b');
    expect(el.querySelector('.theme-message')?.textContent).toContain('"Mosgroen" toegevoegd');
    expect(el.textContent).toContain('Geïmporteerd VS Code-thema');
    expect(JSON.parse(localStorage.getItem(CUSTOM_THEMES_KEY)!)).toHaveLength(1);
    expect(savedCustomThemes()[0]!.name).toBe('Mosgroen');
  });

  it('shows why a file is refused', async () => {
    const { el, choose, store } = await setup();
    await choose('{"name": "leeg"}', 'leeg.json');
    expect(el.querySelector('.theme-message.err-text')?.textContent).toContain(
      'geen VS Code-thema',
    );
    expect(store.custom()).toEqual([]);
  });

  it('removes an imported theme and falls back to Donker', async () => {
    const { el, choose, settle, store } = await setup();
    await choose(THEME);
    el.querySelector<HTMLButtonElement>('.theme-remove')!.click();
    await settle();
    expect(store.custom()).toEqual([]);
    expect(store.choice()).toBe('donker');
    expect(savedCustomThemes()).toEqual([]);
  });
});
