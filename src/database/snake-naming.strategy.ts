import { DefaultNamingStrategy, type NamingStrategyInterface } from 'typeorm';

const snake = (input: string): string =>
  input
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();

/**
 * The database uses snake_case, while TypeORM otherwise uses property names
 * as-is. This global setting maps names like `displayName` to `display_name`
 * and avoids repetitive column-name overrides. Explicit `name:` values still
 * take precedence.
 */
export class SnakeNamingStrategy
  extends DefaultNamingStrategy
  implements NamingStrategyInterface
{
  override columnName(
    propertyName: string,
    customName: string | undefined,
    embeddedPrefixes: string[],
  ): string {
    const prefix = embeddedPrefixes.map(snake).join('_');
    const name = customName || snake(propertyName);
    return prefix ? `${prefix}_${name}` : name;
  }

  override relationName(propertyName: string): string {
    return snake(propertyName);
  }

  override joinColumnName(
    relationName: string,
    referencedColumn: string,
  ): string {
    return snake(`${relationName}_${referencedColumn}`);
  }
}
