// Текст YAML-файла, который сборщик вкладывает в код функции.
declare module '*.yaml' {
  const text: string
  export default text
}
