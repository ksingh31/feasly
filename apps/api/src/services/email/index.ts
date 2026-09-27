export * from './email.types';
export * from './templates';
export * from './email.service';
export { createLogEmailProvider } from './providers/log.provider';
export { createPostmarkEmailProvider } from './providers/postmark.provider';
export {
  createAcsEmailProvider,
  EMAIL_SEND_FAILED_EVENT,
} from './providers/acs.provider';
