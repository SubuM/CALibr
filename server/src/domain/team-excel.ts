import ExcelJS from "exceljs";
import { GROUPS, GROUP_GENERAL } from "../config.js";
import { ValidationError } from "./errors.js";
import { TeamMember } from "./team.js";

const HEADER_ALIASES: Record<string, Set<string>> = {
  first_name: new Set([
    "first name", "first", "firstname", "given name", "fname",
  ]),
  last_name: new Set([
    "last name", "last", "lastname", "surname", "family name", "lname",
  ]),
  department: new Set([
    "department", "dept", "department name", "dept name", "division",
    "business unit", "bu", "function", "unit",
  ]),
  team: new Set([
    "team", "team name", "work team", "work group", "stream", "sub team", "squad",
  ]),
  group: new Set([
    "group", "user group", "usergroup", "access group", "access", "user role",
    "permission", "role group", "security group", "role",
  ]),
};

function normHeader(value: unknown): string {
  return String(value).trim().toLowerCase().replaceAll("_", " ").replaceAll("-", " ");
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isNaN(value)) return "";
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return String(value).trim();
}

export async function parseTeamExcel(data: Buffer): Promise<TeamMember[]> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(toExceljSBuffer(data));
  } catch (exc) {
    throw new ValidationError(`could not read the Excel file: ${String(exc)}`);
  }
  return finish(wb);
}

/** exceljs ships an older @types/node Buffer; bridge the generic mismatch. */
function toExceljSBuffer(data: Buffer): Parameters<typeof ExcelJS.Workbook.prototype.xlsx.load>[0] {
  return data as unknown as Parameters<typeof ExcelJS.Workbook.prototype.xlsx.load>[0];
}

function finish(wb: ExcelJS.Workbook): TeamMember[] {
  const ws = wb.worksheets[0];
  if (!ws) throw new ValidationError("the Excel file has no worksheets");

  const headerRow = ws.getRow(1);
  const colByField: Record<string, number> = {};
  for (let c = 1; c <= headerRow.cellCount; c++) {
    const raw = headerRow.getCell(c).value;
    if (raw === null || raw === undefined || raw instanceof Error) continue;
    const key = normHeader(raw);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (key && aliases.has(key)) {
        if (!(field in colByField)) colByField[field] = c;
        break;
      }
    }
  }

  if (!("first_name" in colByField) || !("last_name" in colByField)) {
    const recognized = [...new Set(Object.values(HEADER_ALIASES).flatMap((s) => [...s]))].sort();
    throw new ValidationError(
      "the Excel file needs First Name & Last Name columns\n" +
        "Recognized header names:\n" +
        recognized.join(", ") +
        "\nColumns: FirstName, LastName, Department, Team, UserGroup",
    );
  }

  const members: TeamMember[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const get = (field: string): string => {
      const c = colByField[field];
      if (c === undefined) return "";
      return cell(row.getCell(c).value);
    };

    const first = get("first_name");
    const last = get("last_name");
    if (!first && !last) return;

    const groupRaw = get("group").toLowerCase();
    const group = groupRaw || GROUP_GENERAL;
    if (!(GROUPS as readonly string[]).includes(group)) {
      problems.push(
        `row ${rowNumber}: invalid group “${groupRaw}” (choose one of: ${GROUPS.join(", ")})`,
      );
      return;
    }

    const member = new TeamMember({
      firstName: first,
      lastName: last,
      department: get("department"),
      team: get("team"),
      group: group as TeamMember["group"],
    });

    if (!member.firstName && !member.lastName) {
      problems.push(`row ${rowNumber}: missing name`);
      return;
    }
    if (!member.fullName) {
      problems.push(`row ${rowNumber}: has no usable name`);
      return;
    }
    if (seen.has(member.key)) {
      problems.push(`row ${rowNumber}: duplicate member “${member.fullName}”`);
    }
    seen.add(member.key);
    members.push(member);
  });

  if (members.length === 0 && problems.length === 0) {
    problems.push("no data rows found");
  }
  if (problems.length > 0) {
    throw new ValidationError("Issue(s) in the Excel file:\n" + problems.map((p) => `• ${p}`).join("\n"));
  }
  return members;
}

export async function teamTemplateBytes(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Team");
  ws.addRow(["FirstName", "LastName", "Department", "Team", "UserGroup"]);
  ws.addRow(["Ada", "Lovelace", "Finance", "Audit", "admin"]);
  ws.addRow(["Alan", "Turing", "IT", "Consulting", "power"]);
  ws.addRow(["Grace", "Hopper", "Finance", "Operations", "general"]);
  ws.columns.forEach((col) => {
    col.width = 18;
  });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}