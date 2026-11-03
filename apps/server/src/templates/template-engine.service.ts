import { Injectable, BadRequestException } from '@nestjs/common';
import * as yaml from 'js-yaml';
import { randomBytes } from 'crypto';
import { formatSlug } from '../projects/projects.utils';
import { recommendedPodSize, type PodSize } from './template-defaults';

export interface ParameterValidation {
  pattern?: string;
  message?: string;
  min?: number;
  max?: number;
  bytes?: number;
  encoding?: 'hex' | 'base64';
}

export interface ParameterOption {
  label: string;
  value: string;
}

export interface ParameterDef {
  name: string;
  displayName: string;
  description?: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'secret';
  default?: any;
  required?: boolean;
  placeholder?: string;
  validation?: ParameterValidation;
  options?: ParameterOption[];
}

function isNameParam(def: ParameterDef): boolean {
  const tokens = def.name.split(/(?=[A-Z])|[_\s-]/).map((t) => t.toLowerCase());
  if (tokens.some((t) => t === 'domain' || t === 'host' || t === 'hostname')) return false;
  return tokens.some((t) => t === 'name');
}

export interface ResourceDef {
  name: string;
  type: 'deployment' | 'database' | 'ingress';
  config: Record<string, any>;
  recommended: PodSize | null;
}

export interface ParsedTemplate {
  apiVersion: string;
  metadata: {
    name: string;
    displayName: string;
    description?: string;
    icon?: string;
    version?: string;
    category?: string;
    tags?: string[];
  };
  parameters: ParameterDef[];
  resources: ResourceDef[];
}

export interface ResolutionContext {
  params: Record<string, any>;
  resources: Record<string, Record<string, any>>;
}

@Injectable()
export class TemplateEngineService {
  parseTemplate(yamlContent: string): ParsedTemplate {
    let doc: any;
    try {
      doc = yaml.load(yamlContent);
    } catch (e) {
      throw new BadRequestException(`Invalid YAML: ${e.message}`);
    }

    if (!doc || typeof doc !== 'object') {
      throw new BadRequestException('Template YAML must be a valid object');
    }

    if (!doc.metadata?.name) {
      throw new BadRequestException('Template must have metadata.name');
    }

    if (!Array.isArray(doc.resources) || doc.resources.length === 0) {
      throw new BadRequestException('Template must define at least one resource');
    }

    const parameters: ParameterDef[] = (doc.parameters || []).map((p: any) => ({
      name: p.name,
      displayName: p.displayName || p.name,
      description: p.description,
      type: p.type || 'string',
      default: p.default,
      required: p.required ?? false,
      placeholder: p.placeholder,
      validation: p.validation,
      options: p.options
    }));

    const resources: ResourceDef[] = doc.resources.map((r: any) => {
      if (!r.name || !r.type || !r.config) {
        throw new BadRequestException(`Each resource must have name, type, and config`);
      }
      if (!['deployment', 'database', 'ingress'].includes(r.type)) {
        throw new BadRequestException(`Invalid resource type: ${r.type}`);
      }
      return {
        name: r.name,
        type: r.type,
        config: r.config,
        recommended: r.type === 'ingress' ? null : recommendedPodSize(r.name, r.type, r.config)
      };
    });

    return {
      apiVersion: doc.apiVersion || 'leaf/v1',
      metadata: {
        name: doc.metadata.name,
        displayName: doc.metadata.displayName || doc.metadata.name,
        description: doc.metadata.description,
        icon: doc.metadata.icon,
        version: doc.metadata.version || '1.0.0',
        category: doc.metadata.category,
        tags: doc.metadata.tags || []
      },
      parameters,
      resources
    };
  }

  validateParameters(
    values: Record<string, any>,
    definitions: ParameterDef[]
  ): Record<string, any> {
    const resolved: Record<string, any> = {};

    for (const def of definitions) {
      let value = values[def.name];

      // Auto-generate secret if not provided
      if (def.type === 'secret' && (value === undefined || value === null || value === '')) {
        if (def.validation?.bytes && def.validation.bytes > 0) {
          value = randomBytes(def.validation.bytes).toString(def.validation.encoding ?? 'hex');
        } else {
          const length =
            def.validation?.min && def.validation.min > 0 ? Math.max(def.validation.min, 16) : 32;
          value = randomBytes(Math.ceil(length / 2))
            .toString('hex')
            .slice(0, length);
        }
      }

      // Apply default
      if (value === undefined || value === null || value === '') {
        if (def.default !== undefined) {
          value = def.default;
        } else if (def.required) {
          throw new BadRequestException(`Parameter "${def.displayName}" is required`);
        }
      }

      // Type coercion
      if (value !== undefined && value !== null) {
        switch (def.type) {
          case 'number':
            value = Number(value);
            if (Number.isNaN(value)) {
              throw new BadRequestException(`Parameter "${def.displayName}" must be a number`);
            }
            if (def.validation?.min !== undefined && value < def.validation.min) {
              throw new BadRequestException(
                `Parameter "${def.displayName}" must be at least ${def.validation.min}`
              );
            }
            if (def.validation?.max !== undefined && value > def.validation.max) {
              throw new BadRequestException(
                `Parameter "${def.displayName}" must be at most ${def.validation.max}`
              );
            }
            break;
          case 'boolean':
            value = value === true || value === 'true';
            break;
          case 'select':
            if (def.options && !def.options.some((o) => o.value === value)) {
              throw new BadRequestException(
                `Parameter "${def.displayName}" must be one of: ${def.options.map((o) => o.value).join(', ')}`
              );
            }
            break;
          case 'string':
            value = String(value);
            if (def.validation?.pattern) {
              const regex = new RegExp(def.validation.pattern);
              if (!regex.test(value)) {
                // Name params become k8s object names, and every other create
                // path slugifies those for the user. Do the same here instead
                // of rejecting "My Cache".
                const slug = isNameParam(def) ? formatSlug(value) : '';
                if (slug && regex.test(slug)) {
                  value = slug;
                } else {
                  throw new BadRequestException(
                    def.validation.message ||
                      `Parameter "${def.displayName}" does not match the required format`
                  );
                }
              }
            }
            break;
          case 'secret':
            value = String(value);
            if (def.validation?.min !== undefined && value.length < def.validation.min) {
              throw new BadRequestException(
                `Parameter "${def.displayName}" must be at least ${def.validation.min} characters`
              );
            }
            if (def.validation?.max !== undefined && value.length > def.validation.max) {
              throw new BadRequestException(
                `Parameter "${def.displayName}" must be at most ${def.validation.max} characters`
              );
            }
            break;
          default:
            break;
        }
      }

      resolved[def.name] = value;
    }

    return resolved;
  }

  resolveValue(value: any, context: ResolutionContext): any {
    if (typeof value === 'string') {
      // Check if the entire value is a single interpolation (for type preservation)
      const singleMatch = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
      if (singleMatch) {
        return this.evaluateExpression(singleMatch[1], context);
      }

      // Otherwise do string interpolation for mixed strings
      return value.replace(/\{\{\s*(.+?)\s*\}\}/g, (_, expr) => {
        const result = this.evaluateExpression(expr.trim(), context);
        return result !== undefined && result !== null ? String(result) : '';
      });
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.resolveValue(item, context));
    }

    if (value && typeof value === 'object') {
      const resolved: Record<string, any> = {};
      for (const [key, val] of Object.entries(value)) {
        resolved[key] = this.resolveValue(val, context);
      }
      return resolved;
    }

    return value;
  }

  private evaluateExpression(expr: string, context: ResolutionContext): any {
    // params.X
    if (expr.startsWith('params.')) {
      const paramName = expr.substring(7);
      return context.params[paramName];
    }

    // resources.X.Y
    if (expr.startsWith('resources.')) {
      const parts = expr.substring(10).split('.');
      if (parts.length === 2) {
        const [resourceName, field] = parts;
        const resource = context.resources[resourceName];
        if (!resource) {
          throw new BadRequestException(
            `Resource "${resourceName}" not found in context. Resources are resolved top-to-bottom.`
          );
        }
        return resource[field];
      }
    }

    throw new BadRequestException(`Invalid expression: {{ ${expr} }}`);
  }

  resolveResourceConfig(resource: ResourceDef, context: ResolutionContext): Record<string, any> {
    return this.resolveValue(resource.config, context);
  }
}
