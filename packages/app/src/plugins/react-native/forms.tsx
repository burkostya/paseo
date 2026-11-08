import type { ComponentProps } from "react";
import type { SelectFieldProps } from "@/components/ui/select-field";
// Keep the bundle evaluator usable outside a mounted native modal tree.
export function Field(props: ComponentProps<typeof import("@/components/ui/form-field").Field>) {
  const { Field: Component } =
    require("../../components/ui/form-field") as typeof import("@/components/ui/form-field");
  return <Component {...props} />;
}
export function FormTextInput(
  props: ComponentProps<typeof import("@/components/ui/form-field").FormTextInput>,
) {
  const { FormTextInput: Component } =
    require("../../components/ui/form-field") as typeof import("@/components/ui/form-field");
  return <Component {...props} />;
}
export function SelectField<Value>(props: SelectFieldProps<Value>) {
  const { SelectField: Component } =
    require("../../components/ui/select-field") as typeof import("@/components/ui/select-field");
  return <Component {...props} />;
}
export function Button(props: ComponentProps<typeof import("@/components/ui/button").Button>) {
  const { Button: Component } =
    require("../../components/ui/button") as typeof import("@/components/ui/button");
  return <Component {...props} />;
}
