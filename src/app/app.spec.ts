import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { DB_API } from './core/db-api';
import { fakeDbApi } from './testing/fake-db-api';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: DB_API, useValue: fakeDbApi() }],
    }).compileComponents();
  });

  it('shows saved connections in the sidebar and as cards', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('.conn-item .conn-name')?.textContent).toContain('lokaal-dev');
    expect(el.querySelector('.card .card-title')?.textContent).toContain('lokaal-dev');
    expect(el.querySelector('.statusbar')?.textContent).toContain('1 profiel');
  });

  it('switches to the connected view after connecting', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    (el.querySelector('.card .btn-primary') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(el.querySelector('h1')?.textContent).toContain('Verbonden met lokaal-dev');
    expect(el.querySelector('.pill-connected')?.textContent).toContain('lokaal-dev');
  });

  it('shows the schema tree and opens a table structure', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    (el.querySelector('.card .btn-primary') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const rowTexts = () =>
      Array.from(el.querySelectorAll('.tree-row')).map((r) =>
        Array.from(r.querySelectorAll('.tl, .count'))
          .map((s) => s.textContent?.trim())
          .join(' '),
      );
    // Profile database open with its tables; system databases hidden by default.
    expect(rowTexts()).toEqual([
      'app_dev',
      'Tabellen 2',
      'customers',
      'orders',
      'Views 1',
      'Routines 1',
      'shop',
    ]);

    const customers = Array.from(el.querySelectorAll<HTMLButtonElement>('.tree-main')).find((b) =>
      b.textContent?.includes('customers'),
    )!;
    customers.click();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(el.querySelector('.object-title')?.textContent).toContain('customers');
    expect(el.querySelector('.object-head')?.textContent).toContain('Klanten');
    const cells = Array.from(el.querySelectorAll('.grid tbody tr')).map((r) =>
      r.children[1]?.textContent?.trim(),
    );
    expect(cells).toEqual(['id', 'email', 'status']);
    expect(el.querySelector('.key-tag.pk')?.textContent).toContain('PK');
  });
});
