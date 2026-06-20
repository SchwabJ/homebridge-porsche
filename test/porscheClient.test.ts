import { HttpClient, HttpResponse } from '../src/http';
import { PorscheClient, computeSpinHash, extractChallenge } from '../src/api/porscheClient';
import { PorscheCommand } from '../src/api/commands';

/** Aufgezeichneter Request, wie ihn die {@link FakeHttpClient} ablegt. */
interface RecordedCall {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
  followRedirects: boolean;
}

/**
 * Test-Doppel für {@link HttpClient}: gibt vorskriptierte Antworten der Reihe
 * nach zurück und zeichnet jeden Aufruf auf. KEINE echten Netzwerk-Calls.
 */
class FakeHttpClient implements HttpClient {
  public calls: RecordedCall[] = [];
  private idx = 0;

  constructor(private responses: HttpResponse[]) {}

  async request(opts: {
    method: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string>;
    body?: string;
    followRedirects: boolean;
  }): Promise<HttpResponse> {
    this.calls.push({
      method: opts.method,
      url: opts.url,
      headers: opts.headers ?? {},
      body: opts.body,
      followRedirects: opts.followRedirects,
    });
    const res = this.responses[this.idx++];
    if (!res) {
      throw new Error(`FakeHttpClient: keine skriptierte Antwort für Aufruf #${this.idx}`);
    }
    return res;
  }
}

/** Bequemer Builder für eine {@link HttpResponse} mit Defaults. */
function resp(partial: Partial<HttpResponse> & { status: number }): HttpResponse {
  return {
    status: partial.status,
    headers: partial.headers ?? {},
    body: partial.body ?? '',
    url: partial.url ?? '',
  };
}

const CLIENT_ID = '41843fb4-691d-4970-85c7-2673e8ecef40';

describe('PorscheClient.listVehicles', () => {
  it('mappt vin + modelName und schickt die korrekten Header', async () => {
    const fake = new FakeHttpClient([
      resp({
        status: 200,
        body: JSON.stringify([{ vin: 'WP0ABC', modelName: 'Taycan' }]),
      }),
    ]);
    const client = new PorscheClient(fake, {
      getAccessToken: () => 'AT1',
      refresh: jest.fn(),
    });

    const vehicles = await client.listVehicles();

    expect(vehicles).toEqual([{ vin: 'WP0ABC', modelName: 'Taycan' }]);
    expect(fake.calls[0].method).toBe('GET');
    expect(fake.calls[0].url).toContain('/connect/v1/vehicles');
    expect(fake.calls[0].headers['X-Client-ID']).toBe(CLIENT_ID);
    expect(fake.calls[0].headers['Authorization']).toBe('Bearer AT1');
  });

  it('mappt auch das Großschreib-Feld VIN', async () => {
    const fake = new FakeHttpClient([
      resp({ status: 200, body: JSON.stringify([{ VIN: 'WP0XYZ' }]) }),
    ]);
    const client = new PorscheClient(fake, {
      getAccessToken: () => 'AT1',
      refresh: jest.fn(),
    });

    const vehicles = await client.listVehicles();
    expect(vehicles[0].vin).toBe('WP0XYZ');
  });
});

describe('PorscheClient.getState', () => {
  it('liefert VehicleState und fragt den gecachten Mess-Endpunkt ohne wakeUpJob an', async () => {
    const fake = new FakeHttpClient([
      resp({
        status: 200,
        // ECHTE PPA-Struktur: Objekt mit measurements-Array (nicht Top-Level-Array)
        body: JSON.stringify({
          vin: 'WP0ABC',
          modelName: 'Taycan',
          measurements: [
            { key: 'BATTERY_LEVEL', value: { percent: 73 } },
            { key: 'E_RANGE', value: { kilometers: 320 } },
            { key: 'CHARGING_SUMMARY', value: { status: 'CHARGING_DC', chargingProfile: { minSoC: 80 } } },
          ],
        }),
      }),
    ]);
    const client = new PorscheClient(fake, {
      getAccessToken: () => 'AT1',
      refresh: jest.fn(),
    });

    const state = await client.getState('WP0ABC', ['BATTERY_LEVEL', 'E_RANGE', 'CHARGING_SUMMARY']);

    expect(state.soc).toBe(73);
    expect(state.rangeKm).toBe(320);
    expect(state.charging).toBe(true);
    expect(state.plugged).toBe(true);
    expect(state.targetSoc).toBe(80);

    expect(fake.calls[0].method).toBe('GET');
    expect(fake.calls[0].url).toContain('/connect/v1/vehicles/WP0ABC');
    expect(fake.calls[0].url).toContain('mf=');
    expect(fake.calls[0].url).not.toContain('wakeUpJob');
  });
});

describe('PorscheClient.sendCommand', () => {
  it('POSTet {key, payload} (Feld heißt key, NICHT commandName) und verfolgt den Job bis PERFORMED', async () => {
    const fake = new FakeHttpClient([
      // POST → 201 Created, Job nur eingereiht (ACCEPTED).
      resp({ status: 201, body: JSON.stringify({ status: { id: 'JOB1', result: 'ACCEPTED' } }) }),
      // GET /commands/JOB1 → vollzogen.
      resp({ status: 200, body: JSON.stringify({ status: { result: 'PERFORMED' } }) }),
    ]);
    const sleep = jest.fn<Promise<void>, [number]>().mockResolvedValue(undefined);
    const client = new PorscheClient(fake, {
      getAccessToken: () => 'AT1',
      refresh: jest.fn(),
      sleep,
    });

    const cmd: PorscheCommand = { commandName: 'LOCK', payload: {} };
    await client.sendCommand('WP0ABC', cmd);

    // Wire-Body nutzt `key` (NICHT `commandName`) — das war der 400-Fix.
    expect(fake.calls[0].method).toBe('POST');
    expect(fake.calls[0].url).toMatch(/\/commands$/);
    const parsed = JSON.parse(fake.calls[0].body!);
    expect(parsed.key).toBe('LOCK');
    expect(parsed.commandName).toBeUndefined();
    expect(parsed.payload).toEqual({});
    expect(fake.calls[0].headers['Content-Type']).toBe('application/json');
    // Job-Status wurde per GET /commands/{id} gepollt.
    expect(fake.calls[1].method).toBe('GET');
    expect(fake.calls[1].url).toMatch(/\/commands\/JOB1$/);
  });

  it('kehrt sofort zurück, wenn der POST schon PERFORMED meldet (kein Job-Poll)', async () => {
    const fake = new FakeHttpClient([
      resp({ status: 201, body: JSON.stringify({ status: { id: 'JOB1', result: 'PERFORMED' } }) }),
    ]);
    const sleep = jest.fn<Promise<void>, [number]>().mockResolvedValue(undefined);
    const client = new PorscheClient(fake, {
      getAccessToken: () => 'AT1',
      refresh: jest.fn(),
      sleep,
    });

    await client.sendCommand('WP0ABC', { commandName: 'REMOTE_CLIMATIZER_STOP', payload: {} });

    expect(fake.calls).toHaveLength(1); // kein Folge-Poll
    expect(sleep).not.toHaveBeenCalled();
  });

  it('wirft, wenn der Job mit ERROR endet', async () => {
    const fake = new FakeHttpClient([
      resp({ status: 201, body: JSON.stringify({ status: { id: 'JOB1', result: 'ACCEPTED' } }) }),
      resp({ status: 200, body: JSON.stringify({ status: { result: 'ERROR' } }) }),
    ]);
    const sleep = jest.fn<Promise<void>, [number]>().mockResolvedValue(undefined);
    const client = new PorscheClient(fake, {
      getAccessToken: () => 'AT1',
      refresh: jest.fn(),
      sleep,
    });

    await expect(
      client.sendCommand('WP0ABC', { commandName: 'LOCK', payload: {} }),
    ).rejects.toThrow(/fehlgeschlagen/);
  });
});

describe('S-PIN-Hash + Challenge-Extraktion', () => {
  it('computeSpinHash trifft die offiziellen CJNE-Testvektoren (Python==Node verifiziert)', () => {
    // Aus der EXAKTEN CJNE-Zeile sha512(bytes.fromhex(pin+challenge)).hexdigest().upper() erzeugt.
    expect(computeSpinHash('4271', 'DEADBEEFCAFE1234')).toBe(
      '3CC4A342277E0F4EBEF27DCDA1A9DFBAF58312783B09FDFC3797A9522EA621429C8A887074E436E14C75F2436B8535BEA8CEFF936F5299BE13DD6FED08D716FD',
    );
    expect(computeSpinHash('0000', '00')).toBe(
      '6D518F8B31D1882FEACE10A9215F5D8CF5AFE037652A1D11D9C1408D988C2A4F71A5EDFC85D0712FA3F4E21B2C0A244C8C0D333BAB454311E24067D2A83E5E59',
    );
    expect(computeSpinHash('1234', '00112233445566778899AABBCCDDEEFF00112233445566778899AABBCCDDEEFF')).toBe(
      'D1C9CDA3B50BB95184F09923D91476BC5E4CCC7E87807D9126EF93095976B2823CF083D3625078932E6CDE661D226F4903714A001ED980BFB72CE04FAB7D59F5',
    );
  });

  it('computeSpinHash wirft bei ungerader Hex-Länge (statt still zu trunkieren wie Node)', () => {
    // pin(4) + challenge(3) = 7 Zeichen → ungerade → muss werfen.
    expect(() => computeSpinHash('1234', 'abc')).toThrow(/Hex/);
    // Nicht-Hex-Zeichen → muss werfen.
    expect(() => computeSpinHash('12ZZ', 'a1b2')).toThrow(/Hex/);
  });

  it('extractChallenge findet die challenge an bekannten Pfaden', () => {
    expect(extractChallenge({ challenge: 'ab12' })).toBe('ab12');
    expect(extractChallenge({ data: { challenge: 'cd34' } })).toBe('cd34');
    expect(extractChallenge({ status: { challenge: 'ef56' } })).toBe('ef56');
    expect(extractChallenge({})).toBeUndefined();
    expect(extractChallenge(null)).toBeUndefined();
  });
});

describe('PorscheClient.unlock (S-PIN-Flow)', () => {
  it('POSTet SPIN_CHALLENGE, berechnet den Hash und sendet UNLOCK mit {spin:{challenge,hash}}', async () => {
    const challenge = 'a1b2c3d4e5f6';
    const fake = new FakeHttpClient([
      // 1. SPIN_CHALLENGE → 201 mit challenge.
      resp({ status: 201, body: JSON.stringify({ challenge }) }),
      // 2. UNLOCK → 201, sofort PERFORMED.
      resp({ status: 201, body: JSON.stringify({ status: { result: 'PERFORMED' } }) }),
    ]);
    const client = new PorscheClient(fake, {
      getAccessToken: () => 'AT1',
      refresh: jest.fn(),
    });

    await client.unlock('WP0ABC', '1234');

    // Schritt 1: SPIN_CHALLENGE mit key + spin:null.
    const c0 = JSON.parse(fake.calls[0].body!);
    expect(c0.key).toBe('SPIN_CHALLENGE');
    expect(c0.payload).toEqual({ spin: null });
    // Schritt 2: UNLOCK mit key + spin{challenge, hash}.
    const c1 = JSON.parse(fake.calls[1].body!);
    expect(c1.key).toBe('UNLOCK');
    expect(c1.payload.spin.challenge).toBe(challenge);
    expect(c1.payload.spin.hash).toBe(computeSpinHash('1234', challenge));
  });

  it('wirft, wenn SPIN_CHALLENGE keine challenge liefert', async () => {
    const fake = new FakeHttpClient([resp({ status: 201, body: JSON.stringify({}) })]);
    const client = new PorscheClient(fake, {
      getAccessToken: () => 'AT1',
      refresh: jest.fn(),
    });
    await expect(client.unlock('WP0ABC', '1234')).rejects.toThrow(/challenge/);
  });
});

describe('PorscheClient 401-Pfad', () => {
  it('ruft refresh genau einmal und wiederholt den Request mit dem neuen Bearer', async () => {
    const fake = new FakeHttpClient([
      resp({ status: 401 }),
      resp({ status: 200, body: JSON.stringify([{ vin: 'WP0ABC', modelName: 'Taycan' }]) }),
    ]);
    const refresh = jest.fn<Promise<string>, []>().mockResolvedValue('AT2');
    const client = new PorscheClient(fake, {
      getAccessToken: () => 'AT1',
      refresh,
    });

    const vehicles = await client.listVehicles();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fake.calls[0].headers['Authorization']).toBe('Bearer AT1');
    expect(fake.calls[1].headers['Authorization']).toBe('Bearer AT2');
    expect(vehicles).toEqual([{ vin: 'WP0ABC', modelName: 'Taycan' }]);
  });

  it('wirft, wenn auch nach Refresh erneut 401 kommt', async () => {
    const fake = new FakeHttpClient([resp({ status: 401 }), resp({ status: 401 })]);
    const refresh = jest.fn<Promise<string>, []>().mockResolvedValue('AT2');
    const client = new PorscheClient(fake, {
      getAccessToken: () => 'AT1',
      refresh,
    });

    await expect(client.listVehicles()).rejects.toThrow();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('PorscheClient 429-Pfad', () => {
  it('macht Backoff-Retries und liefert nach Erfolg das Ergebnis', async () => {
    const fake = new FakeHttpClient([
      resp({ status: 429 }),
      resp({ status: 429 }),
      resp({ status: 200, body: JSON.stringify([{ vin: 'WP0ABC' }]) }),
    ]);
    const sleep = jest.fn<Promise<void>, [number]>().mockResolvedValue(undefined);
    const client = new PorscheClient(fake, {
      getAccessToken: () => 'AT1',
      refresh: jest.fn(),
      sleep,
    });

    const vehicles = await client.listVehicles();

    expect(vehicles).toEqual([{ vin: 'WP0ABC', modelName: undefined }]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 5000);
    expect(sleep).toHaveBeenNthCalledWith(2, 10000);
  });
});
