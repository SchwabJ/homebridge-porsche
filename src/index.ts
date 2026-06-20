import { API } from 'homebridge';
import { PorschePlatform, PLATFORM_NAME } from './platform';

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, PorschePlatform);
};
