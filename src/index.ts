import { API } from 'homebridge';
import { TaycanPlatform, PLATFORM_NAME } from './platform';

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, TaycanPlatform);
};
