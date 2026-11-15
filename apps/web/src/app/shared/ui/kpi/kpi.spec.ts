import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { StatusTone } from '../status/status-dictionary';
import { KpiGridComponent, KpiTileComponent } from './kpi-tile.component';
import { type MoneyStripItem, moneyStripTone, tierMoneyStripItems } from './money-strip';
import { MoneyStripComponent } from './money-strip.component';

describe('money strip tiering', () => {
  const items: MoneyStripItem[] = [
    { text: '$19,800 charges tonight', tone: 'info' },
    { text: '2 in review', tone: 'warning' },
    { text: '1 card failed', tone: 'danger' },
    { text: '1 disputed', tone: 'paused' },
    { text: '3 in review', tone: 'warning' },
  ];

  it('orders most severe first, keeping ties in input order', () => {
    expect(tierMoneyStripItems(items).map((i) => i.text)).toEqual([
      '1 card failed',
      '2 in review',
      '3 in review',
      '1 disputed',
      '$19,800 charges tonight',
    ]);
  });

  it('takes the tone of the most severe item', () => {
    expect(moneyStripTone(items)).toBe('danger');
    expect(moneyStripTone([{ text: 'All paid', tone: 'success' }])).toBe('success');
    expect(moneyStripTone([])).toBe('neutral');
  });
});

@Component({
  standalone: true,
  imports: [KpiGridComponent, KpiTileComponent, MoneyStripComponent],
  template: `
    <ui-kpi-grid>
      <ui-kpi-tile label="Open leads" value="1,843" sub="12 new this week" [tone]="tone()" />
      <ui-kpi-tile label="Due" value="$19,800" [interactive]="true" (activate)="activations = activations + 1" />
    </ui-kpi-grid>
    <ui-money-strip [items]="items()" [ctaLabel]="cta()" (cta)="ctaClicks = ctaClicks + 1" />
  `,
})
class HostComponent {
  readonly tone = signal<StatusTone | undefined>(undefined);
  readonly items = signal<readonly MoneyStripItem[]>([
    { text: '$19,800 charges tonight', tone: 'info' },
    { text: '1 card failed', tone: 'danger' },
  ]);
  readonly cta = signal<string | undefined>('Update card');
  activations = 0;
  ctaClicks = 0;
}

describe('KpiTile + MoneyStrip', () => {
  let fixture: ComponentFixture<HostComponent>;

  function setup(): HostComponent {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  function tiles(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.kpi'));
  }

  it('renders label, value and sub; static tiles are not buttons', () => {
    setup();
    const [first] = tiles();
    expect(first.tagName).toBe('DIV');
    expect(first.querySelector('.kpi__label')?.textContent).toBe('Open leads');
    expect(first.querySelector('.kpi__value')?.textContent).toBe('1,843');
    expect(first.querySelector('.kpi__sub')?.textContent).toBe('12 new this week');
    expect(tiles()[1].querySelector('.kpi__sub')).toBeNull();
  });

  it('applies the tone border class only when a tone is set', () => {
    const host = setup();
    expect(tiles()[0].className).toBe('kpi');
    host.tone.set('danger');
    fixture.detectChanges();
    expect(tiles()[0].classList).toContain('kpi--danger');
  });

  it('interactive tiles are buttons that emit activate', () => {
    const host = setup();
    const button = tiles()[1] as HTMLButtonElement;
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    button.click();
    expect(host.activations).toBe(1);
  });

  it('money strip renders one tiered line led by the most severe item', () => {
    setup();
    const strip = fixture.nativeElement.querySelector('.money-strip') as HTMLElement;
    expect(strip.classList).toContain('money-strip--danger');
    expect(strip.querySelector('.money-strip__line')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '1 card failed · $19,800 charges tonight',
    );
    expect(strip.querySelectorAll('button').length).toBe(1);
  });

  it('money strip CTA emits, can be omitted, and the strip hides when empty', () => {
    const host = setup();
    (fixture.nativeElement.querySelector('.money-strip__cta') as HTMLButtonElement).click();
    expect(host.ctaClicks).toBe(1);

    host.cta.set(undefined);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.money-strip__cta')).toBeNull();

    host.items.set([]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.money-strip')).toBeNull();
  });
});
