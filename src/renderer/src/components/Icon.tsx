interface IconProps {
  name: string
  color?: string
  className?: string
  title?: string
}

/** Icône de la police Codicons de VS Code. */
export function Icon({ name, color, className, title }: IconProps) {
  return (
    <i
      className={`codicon codicon-${name}${className ? ` ${className}` : ''}`}
      style={color ? { color } : undefined}
      title={title}
      aria-hidden={title ? undefined : true}
    />
  )
}
