export interface HassEntity {
  readonly entity_id: string;
  readonly state: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface EntityRegistryDisplayEntry {
  readonly entity_id: string;
  readonly device_id?: string;
  readonly platform?: string;
  readonly translation_key?: string;
  readonly name?: string;
  readonly hidden?: boolean;
}

export interface DeviceRegistryEntry {
  readonly id: string;
  readonly name: string | null;
  readonly name_by_user: string | null;
  readonly model: string | null;
}

export interface ServiceCallResponse<T = unknown> {
  readonly response?: T;
}

/** The subset of the Home Assistant frontend `hass` object this card relies on. */
export interface HomeAssistant {
  readonly states: Readonly<Record<string, HassEntity>>;
  readonly entities: Readonly<Record<string, EntityRegistryDisplayEntry>>;
  readonly devices: Readonly<Record<string, DeviceRegistryEntry>>;
  readonly language: string;
  readonly locale?: { readonly language: string };
  readonly themes?: { readonly darkMode?: boolean };
  readonly translationMetadata?: {
    readonly translations: Readonly<Record<string, { readonly isRTL?: boolean }>>;
  };
  callService<T = unknown>(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: { entity_id?: string | string[] },
    notifyOnError?: boolean,
    returnResponse?: boolean,
  ): Promise<ServiceCallResponse<T>>;
  formatEntityState?(stateObj: HassEntity, state?: string): string;
}
