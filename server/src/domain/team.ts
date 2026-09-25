import { GROUP_GENERAL, type GroupName } from "../config.js";

export class TeamMember {
  firstName: string;
  lastName: string;
  department: string;
  team: string;
  group: GroupName;

  constructor(input: {
    firstName: string;
    lastName: string;
    department?: string;
    team?: string;
    group?: GroupName;
  }) {
    this.firstName = input.firstName;
    this.lastName = input.lastName;
    this.department = input.department ?? "";
    this.team = input.team ?? "";
    this.group = input.group ?? GROUP_GENERAL;
  }

  get fullName(): string {
    return [this.firstName, this.lastName].filter((p) => p).join(" ").trim();
  }

  /** Stable identity: normalized full name (first name + last name). */
  get key(): string {
    return this.fullName.toLowerCase().split(/\s+/).join(" ");
  }

  toJSON() {
    return {
      firstName: this.firstName,
      lastName: this.lastName,
      department: this.department,
      team: this.team,
      group: this.group,
      fullName: this.fullName,
    };
  }
}