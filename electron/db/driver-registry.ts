import type { DbType } from '../../shared/models';
import { AppError } from '../ipc/errors';
import type { DbDriver } from './driver';
import { mysqlDriver } from './mysql.driver';

const drivers = new Map<DbType, DbDriver>([[mysqlDriver.type, mysqlDriver]]);

export function getDriver(type: DbType): DbDriver {
  const driver = drivers.get(type);
  if (!driver) {
    throw new AppError(
      'DRIVER_NOT_AVAILABLE',
      `Databasetype "${type}" wordt nog niet ondersteund.`,
    );
  }
  return driver;
}
