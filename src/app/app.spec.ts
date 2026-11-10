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
});
