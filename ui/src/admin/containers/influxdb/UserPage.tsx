import React, {useState} from 'react'
import {connect, ResolveThunks} from 'react-redux'
import {withSource} from 'src/CheckSources'
import {Source} from 'src/types'
import {Database, User, UserPermission, UserRole} from 'src/types/influxAdmin'
import {hasRoleManagement, isConnectedToLDAP} from './AdminInfluxDBTabbedPage'
import {withRouter, WithRouterProps} from 'react-router'
import {useMemo} from 'react'
import ConfirmButton from 'src/shared/components/ConfirmButton'
import {
  deleteUserAsync,
  updateUserPasswordAsync,
  updateUserPermissionsAsync,
} from 'src/admin/actions/influxdb'
import {Button, ComponentColor, ComponentStatus, Page} from 'src/reusable_ui'
import ConfirmOrCancel from 'src/shared/components/ConfirmOrCancel'
import FancyScrollbar from 'src/shared/components/FancyScrollbar'
import {useEffect} from 'react'
import {useCallback} from 'react'
import {PERMISSIONS} from 'src/shared/constants'

const FAKE_USER: User = {
  name: '',
  permissions: [],
  roles: [],
}

const mapStateToProps = ({
  adminInfluxDB: {databases, users, roles, permissions},
}) => ({
  databases,
  users,
  roles,
  permissions,
})

interface RouterParams {
  sourceID: string
  userName: string
}

const mapDispatchToProps = {
  deleteUserAsync,
  updateUserPasswordAsync,
  updateUserPermissionsAsync,
}

interface OwnProps {
  source: Source
}
interface ConnectedProps {
  users: User[]
  roles: UserRole[]
  permissions: UserPermission[]
  databases: Database[]
}

type ReduxDispatchProps = ResolveThunks<typeof mapDispatchToProps>
type Props = WithRouterProps<RouterParams> &
  OwnProps &
  ConnectedProps &
  ReduxDispatchProps

const UserPage = ({
  users,
  databases,
  permissions: serverPermissions,
  source,
  router,
  params: {userName, sourceID},
  deleteUserAsync: deleteUserDispatchAsync,
  updateUserPasswordAsync: updatePasswordAsync,
  updateUserPermissionsAsync: updatePermissionsAsync,
}: Props) => {
  if (isConnectedToLDAP(source)) {
    return <div className="container-fluid">Users are managed via LDAP.</div>
  }
  const [running, setRunning] = useState(false)
  const [password, setPassword] = useState<string | undefined>(undefined)
  const [user, deleteUser] = useMemo(() => {
    const u = users.find(x => x.name === userName) || FAKE_USER
    return [
      u,
      async () => {
        setRunning(true)
        try {
          await deleteUserDispatchAsync(u)
          router.push(`/sources/${sourceID}/admin-influxdb/users`)
        } finally {
          setRunning(false)
        }
      },
    ]
  }, [source, users, userName])
  const updatePassword = useMemo(
    () => async () => {
      setRunning(true)
      try {
        await updatePasswordAsync(user, password)
        setPassword(undefined)
      } finally {
        setRunning(false)
      }
    },
    [user, password]
  )
  const isOSS = !hasRoleManagement(source)
  const isAdmin =
    isOSS &&
    !!user.permissions.find(
      x => x.scope === 'all' && (x.allowed || []).includes('ALL')
    )
  const changeAdmin = useMemo(
    () => async () => {
      setRunning(true)
      try {
        let permissions = (user.permissions || []).filter(
          x => x.scope !== 'all'
        )
        if (!isAdmin) {
          permissions = [{scope: 'all', allowed: ['ALL']}, ...permissions]
        }
        await updatePermissionsAsync(user, permissions)
        setPassword(undefined)
      } finally {
        setRunning(false)
      }
    },
    [user, isAdmin]
  )
  const [dbPermisssions, clusterPermissions, userDBPermissions] = useMemo(
    () => [
      serverPermissions.find(x => x.scope === 'database')?.allowed || [],
      serverPermissions.find(x => x.scope === 'all')?.allowed || [],
      user.permissions.reduce((acc, perm) => {
        if (isOSS && perm.scope !== 'database') {
          return acc // do not include all permissions in OSS, they have separate administration
        }
        const dbName = perm.name || ''
        const dbPerms = acc[dbName] || (acc[dbName] = {})
        perm.allowed.forEach(x => (dbPerms[x] = true))
        return acc
      }, {}),
    ],
    [serverPermissions, user, isOSS]
  )

  const [changedPermissions, setChangedPermissions] = useState<
    Record<string, Record<string, boolean | undefined>>
  >({})
  useEffect(() => {
    setChangedPermissions({})
  }, [user])
  const onPermissionChange = useMemo(
    () => (e: React.MouseEvent<HTMLSpanElement>) => {
      const db = (e.target as HTMLSpanElement).dataset.db
      const perm = (e.target as HTMLSpanElement).dataset.perm
      const origState = userDBPermissions[db]?.[perm]
      const {[db]: changedDB, ...otherDBs} = changedPermissions
      if (changedDB === undefined) {
        setChangedPermissions({[db]: {[perm]: !origState}, ...otherDBs})
      } else {
        const {[perm]: changedPerm, ...otherPerms} = changedDB
        if (changedPerm === undefined) {
          setChangedPermissions({
            [db]: {[perm]: !origState, ...otherPerms},
            ...otherDBs,
          })
        } else if (Object.keys(otherPerms).length) {
          // we are changing back has been already changed,
          // adjust changed database permissions
          setChangedPermissions({
            [db]: otherPerms,
            ...otherDBs,
          })
        } else {
          // there is no change for the current database
          setChangedPermissions(otherDBs)
        }
      }
      return
    },
    [userDBPermissions, changedPermissions, setChangedPermissions]
  )
  const permissionsChanged = !!Object.keys(changedPermissions).length
  const changePermissions = useMemo(
    () => async () => {
      if (Object.entries(changedPermissions).length === 0) {
        return
      }
      setRunning(true)
      try {
        const newUserDBPermisssions = {...userDBPermissions}
        Object.entries(changedPermissions).forEach(([db, perms]) => {
          if (newUserDBPermisssions[db]) {
            newUserDBPermisssions[db] = {
              ...newUserDBPermisssions[db],
              ...perms,
            }
          } else {
            newUserDBPermisssions[db] = {...perms}
          }
        })
        const permissions = Object.entries(newUserDBPermisssions).reduce(
          (acc, [db, permRecord]) => {
            const allowed = Object.entries(permRecord).reduce(
              (allowedAcc, [perm, use]) => {
                if (use) {
                  allowedAcc.push(perm)
                }
                return allowedAcc
              },
              []
            )
            if (allowed.length) {
              acc.push({
                scope: db ? 'database' : 'all',
                name: db || undefined,
                allowed,
              })
            }
            return acc
          },
          isOSS
            ? (user.permissions || []).filter(x => x.scope !== 'database')
            : []
        )
        await updatePermissionsAsync(user, permissions)
      } finally {
        setRunning(false)
      }
    },
    [user, changedPermissions, userDBPermissions, isOSS]
  )
  const exitHandler = useCallback(() => {
    router.push(`/sources/${sourceID}/admin-influxdb/users`)
  }, [router, source])

  const dataChanged = useMemo(() => permissionsChanged, [permissionsChanged])
  const databaseNames = useMemo<string[]>(
    () =>
      databases.reduce(
        (acc, db) => {
          acc.push(db.name)
          return acc
        },
        isOSS ? [] : ['']
      ),
    [isOSS, databases]
  )

  const body =
    user === FAKE_USER ? (
      <div className="container-fluid">
        User <span className="error-warning">{userName}</span> not found!
      </div>
    ) : (
      <div className="panel panel-solid influxdb-admin">
        <div className="panel-heading">
          <h2 className="panel-title">
            {password === undefined ? '' : 'Set password for user: '}
            <span title={`User: ${userName}`}>{userName}</span>
          </h2>
          {password === undefined && (
            <div className="panel-heading--right">
              <Button
                text="Change password"
                onClick={() => setPassword('')}
                status={
                  running ? ComponentStatus.Disabled : ComponentStatus.Default
                }
              />
              {isOSS && (
                <ConfirmButton
                  type="btn-default"
                  text={isAdmin ? 'Revoke Admin' : 'Grant Admin'}
                  confirmText={
                    isAdmin ? 'Revoke ALL Privileges' : 'Grant ALL Privileges'
                  }
                  confirmAction={changeAdmin}
                  disabled={running}
                  position="bottom"
                ></ConfirmButton>
              )}
              <ConfirmButton
                type="btn-danger"
                text="Delete User"
                confirmAction={deleteUser}
                disabled={running}
                position="bottom"
              ></ConfirmButton>
            </div>
          )}
        </div>
        <div className="panel-body influxdb-admin--detail">
          {password !== undefined ? (
            <div className="influxdb-admin--pwdchange">
              <input
                className="form-control input-sm"
                name="password"
                type="password"
                value={password}
                placeholder="New Password"
                disabled={running}
                onChange={e => setPassword(e.target.value)}
                onKeyPress={e => {
                  if (e.key === 'Enter') {
                    updatePassword()
                  }
                }}
                style={{flex: '0 0 auto', width: '200px'}}
                spellCheck={false}
                autoComplete="false"
              />
              <ConfirmOrCancel
                item={user}
                onConfirm={updatePassword}
                isDisabled={running}
                onCancel={() => setPassword(undefined)}
                buttonSize="btn-sm"
              />
            </div>
          ) : (
            <FancyScrollbar>
              <div className="infludb-admin-section__header">
                <h4>
                  {isOSS ? 'Database Permissions' : 'Permissions'}
                  {permissionsChanged ? ' (unsaved)' : ''}
                </h4>
              </div>
              <div className="infludb-admin-section__body">
                {isAdmin && (
                  <p>
                    The user is an <b>admin</b>, ALL PRIVILEGES are granted
                    irrespectively of database permissions.
                  </p>
                )}
                <div>
                  <table className="table v-center table-highlight permission-table">
                    <thead>
                      <tr>
                        <th style={{minWidth: '100px', whiteSpace: 'nowrap'}}>
                          Database
                        </th>
                        <th style={{width: '99%', whiteSpace: 'nowrap'}}>
                          Permissions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {(databaseNames || []).map(db => (
                        <tr
                          key={db}
                          className={db ? '' : 'all-databases'}
                          title={
                            db
                              ? db
                              : 'Cluster-Wide Permissions applies to all databases'
                          }
                        >
                          <td>{db || '*'}</td>
                          <td>
                            {(db ? dbPermisssions : clusterPermissions).map(
                              (perm, i) => (
                                <div
                                  key={i}
                                  title={
                                    PERMISSIONS[perm]?.description ||
                                    'Click to change, click Apply Changes to save all changes'
                                  }
                                  data-db={db}
                                  data-perm={perm}
                                  className={`permission-value ${
                                    userDBPermissions[db]?.[perm]
                                      ? 'granted'
                                      : 'denied'
                                  } ${
                                    changedPermissions[db]?.[perm] !== undefined
                                      ? 'perm-changed'
                                      : ''
                                  }`}
                                  onClick={onPermissionChange}
                                >
                                  {perm}
                                </div>
                              )
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </FancyScrollbar>
          )}
        </div>
      </div>
    )
  return (
    <Page className="influxdb-admin">
      <Page.Header fullWidth={true}>
        <Page.Header.Left>
          <Page.Title title="Manage User" />
        </Page.Header.Left>
        <Page.Header.Right showSourceIndicator={true}>
          {permissionsChanged ? (
            <ConfirmButton
              text="Exit"
              confirmText="Discard unsaved changes?"
              confirmAction={exitHandler}
              position="left"
            />
          ) : (
            <Button text="Exit" onClick={exitHandler} />
          )}
          {dataChanged && (
            <Button
              text="Apply Changes"
              onClick={changePermissions}
              color={ComponentColor.Secondary}
              status={
                running ? ComponentStatus.Disabled : ComponentStatus.Default
              }
            />
          )}
        </Page.Header.Right>
      </Page.Header>
      <div className="influxdb-admin--contents">{body}</div>
    </Page>
  )
}

export default withSource(
  withRouter(connect(mapStateToProps, mapDispatchToProps)(UserPage))
)
