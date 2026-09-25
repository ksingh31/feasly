import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { adminGuard } from './admin.guard';
import { ConfigService } from '../../core/config/config.service';

describe('adminGuard', () => {
  async function runGuard(adminKey: string) {
    const configStub = {
      get: (section: string) => (section === 'admin' ? { adminKey } : {}),
    };
    const router = { createUrlTree: (commands: unknown[]) => ({ commands }) };
    await TestBed.configureTestingModule({
      providers: [
        { provide: ConfigService, useValue: configStub },
        { provide: Router, useValue: router },
      ],
    }).compileComponents();
    return TestBed.runInInjectionContext(() =>
      adminGuard({} as never, {} as never),
    );
  }

  it('allows the route when an admin key is configured', async () => {
    expect(await runGuard('secret-key')).toBe(true);
  });

  it('redirects to / when no admin key is configured', async () => {
    const result = (await runGuard('')) as unknown as { commands: unknown[] };
    expect(result.commands).toEqual(['/']);
  });

  it('redirects to / for a whitespace-only key', async () => {
    const result = (await runGuard('   ')) as unknown as { commands: unknown[] };
    expect(result.commands).toEqual(['/']);
  });
});
